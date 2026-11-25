//! 对象树上的"新建 / 删除库或模式"和"表空间"列表。
//!
//! 新建、删除和删表一样：语句由方言生成（见 `datluma_dialect::NamespaceChange`），先预览再执行；执行前过执行策略，
//! 生产连接上删除要输入名称，系统库、系统模式不能删；执行后记入历史并清掉这个连接的元数据缓存。
//! 表空间只读：Oracle、达梦读 DBA 视图（没有权限时退到只列名字），PG 系读 `pg_tablespace`。

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use datluma_core::{Error, Msg, Result, msg};
use datluma_dialect::meta::{MetaArgs, MetaKey, MetaRows};
use datluma_dialect::{Family, NamespaceCaps, NamespaceChange};
use datluma_driver::collect_all;
use serde::{Deserialize, Serialize};

use crate::history::NewHistory;
use crate::import::exec;
use crate::policy::{ExecContext, Operation, report};
use crate::profile::{Environment, driver_name, variant_code};
use crate::service::Service;

/// 预览：要执行的语句和要确认的事项。
#[derive(Debug, Clone, Serialize)]
pub struct NamespacePreview {
    pub statements: Vec<String>,
    pub profile_name: String,
    pub production: bool,
    /// 生产连接上删除时要输入的名称。
    pub confirm_name: Option<String>,
    /// 删除时里面还有多少张表（读不到时为 None）。
    pub tables: Option<u64>,
    /// 执行策略要确认的原因。
    pub confirm: Vec<Msg>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NamespaceRequest {
    /// SQL Server 在哪个库里建、删架构；其他情况不填。
    #[serde(default)]
    pub catalog: Option<String>,
    pub change: NamespaceChange,
    /// 生产连接上删除时用户输入的名称。
    #[serde(default)]
    pub confirm_name: Option<String>,
}

/// 一个表空间。大小以字节计，读不到时为 None。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Tablespace {
    pub name: String,
    /// Oracle、达梦的 `PERMANENT` / `TEMPORARY` / `UNDO`。
    pub kind: Option<String>,
    pub total: Option<i64>,
    pub used: Option<i64>,
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_millis() as i64)
}

/// 表空间查询，按顺序尝试，第一条成功的为准。
fn tablespace_queries(family: Family) -> &'static [&'static str] {
    match family {
        Family::Oracle => &[
            "SELECT t.tablespace_name AS name, t.contents AS kind, d.total AS total, \
             CASE WHEN t.contents = 'TEMPORARY' THEN NULL ELSE d.total - NVL(f.free, 0) END AS used \
             FROM dba_tablespaces t \
             LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS total FROM dba_data_files GROUP BY tablespace_name \
                        UNION ALL SELECT tablespace_name, SUM(bytes) FROM dba_temp_files GROUP BY tablespace_name) d \
               ON d.tablespace_name = t.tablespace_name \
             LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS free FROM dba_free_space GROUP BY tablespace_name) f \
               ON f.tablespace_name = t.tablespace_name \
             ORDER BY t.tablespace_name",
            "SELECT tablespace_name AS name, contents AS kind, NULL AS total, NULL AS used FROM user_tablespaces \
             ORDER BY tablespace_name",
        ],
        Family::Dameng => &[
            "SELECT t.tablespace_name AS name, t.contents AS kind, d.total AS total, \
             CASE WHEN t.contents = 'TEMPORARY' THEN NULL ELSE d.total - NVL(f.free, 0) END AS used \
             FROM dba_tablespaces t \
             LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS total FROM dba_data_files GROUP BY tablespace_name) d \
               ON d.tablespace_name = t.tablespace_name \
             LEFT JOIN (SELECT tablespace_name, SUM(bytes) AS free FROM dba_free_space GROUP BY tablespace_name) f \
               ON f.tablespace_name = t.tablespace_name \
             ORDER BY t.tablespace_name",
            "SELECT name AS name, NULL AS kind, NULL AS total, NULL AS used FROM v$tablespace ORDER BY name",
        ],
        // PG 的表空间只有已用大小（pg_tablespace_size），没有容量上限
        Family::Postgres => &[
            "SELECT spcname AS name, NULL AS kind, NULL AS total, pg_tablespace_size(oid) AS used \
             FROM pg_tablespace ORDER BY spcname",
            "SELECT spcname AS name, NULL AS kind, NULL AS total, NULL AS used FROM pg_tablespace ORDER BY spcname",
        ],
        Family::MySql | Family::SqlServer | Family::Sqlite | Family::Informix => &[],
    }
}

impl Service {
    pub async fn namespace_caps(&self, profile_id: &str) -> Result<NamespaceCaps> {
        let profile = self.profile(profile_id)?;
        Ok(self.metadata.dialect(&profile).await?.namespace_caps())
    }

    /// 要删除的库或模式是不是系统的（树上不显示，这里再拦一次）。
    async fn system_namespace(
        &self,
        profile_id: &str,
        change: &NamespaceChange,
        catalog: Option<&str>,
    ) -> Result<bool> {
        let profile = self.scoped_profile(profile_id, catalog)?;
        let dialect = self.metadata.dialect(&profile).await?;
        let list = match change {
            // SQL Server 的库在库列表里；MySQL 系的库就是模式
            NamespaceChange::DropDatabase { .. } if dialect.family() == Family::SqlServer => {
                self.metadata.catalogs(&profile, None).await?
            }
            NamespaceChange::DropDatabase { .. } | NamespaceChange::DropSchema { .. } => {
                self.metadata.schemas(&profile, None).await?
            }
            _ => return Ok(false),
        };
        Ok(list.iter().any(|s| s.is_system && s.name.eq_ignore_ascii_case(change.name())))
    }

    pub async fn namespace_preview(
        &self,
        profile_id: &str,
        req: &NamespaceRequest,
    ) -> Result<NamespacePreview> {
        let profile = self.scoped_profile(profile_id, req.catalog.as_deref())?;
        let dialect = self.metadata.dialect(&profile).await?;
        let statements = dialect.namespace_statements(&req.change)?;
        if self.system_namespace(profile_id, &req.change, req.catalog.as_deref()).await? {
            return Err(Error::invalid(msg!("namespace.system", name = req.change.name())));
        }
        let (denied, confirm) = self.check_policy(&profile, dialect, Operation::Design, &statements).await;
        if let Some(reason) = denied {
            return Err(Error::Denied { reason });
        }
        let production = profile.input.environment == Environment::Prod;
        let drop = req.change.is_drop();
        // 删除前数一下里面的表，只是提示：读不到不影响预览（SQL Server 删整个库时不数）
        let tables = match &req.change {
            NamespaceChange::DropDatabase { .. } if dialect.family() == Family::SqlServer => None,
            NamespaceChange::DropDatabase { name } | NamespaceChange::DropSchema { name } => {
                let args = MetaArgs { schema: Some(name.clone()), ..Default::default() };
                self.metadata
                    .rows(&profile, MetaKey::Tables, &args)
                    .await
                    .ok()
                    .flatten()
                    .map(|r| r.len() as u64)
            }
            _ => None,
        };
        Ok(NamespacePreview {
            statements,
            profile_name: profile.input.name.clone(),
            production,
            confirm_name: (drop && production).then(|| req.change.name().to_string()),
            tables,
            confirm,
        })
    }

    /// 执行：逐条执行，记入历史，清掉缓存。删 SQL Server 的库前先关掉元数据连接，免得自己占着这个库。
    pub async fn namespace_apply(&self, profile_id: &str, req: &NamespaceRequest) -> Result<()> {
        let profile = self.scoped_profile(profile_id, req.catalog.as_deref())?;
        let dialect = self.metadata.dialect(&profile).await?;
        let statements = dialect.namespace_statements(&req.change)?;
        if self.system_namespace(profile_id, &req.change, req.catalog.as_deref()).await? {
            return Err(Error::invalid(msg!("namespace.system", name = req.change.name())));
        }
        if req.change.is_drop()
            && profile.input.environment == Environment::Prod
            && req.confirm_name.as_deref() != Some(req.change.name())
        {
            return Err(Error::invalid(msg!("namespace.confirm_name")));
        }
        let (denied, _) = self.check_policy(&profile, dialect, Operation::Design, &statements).await;
        if let Some(reason) = denied {
            return Err(Error::Denied { reason });
        }
        if matches!(req.change, NamespaceChange::DropDatabase { .. }) && dialect.family() == Family::SqlServer
        {
            self.metadata.forget(profile_id).await?;
        }
        let password = self.password(&profile.id).await?;
        let (mut conn, _) = self.registry.connect(&profile, password).await?;
        let ctx = ExecContext::new(&profile, dialect, Operation::Design);
        let mut outcome = Ok(());
        for sql in &statements {
            let (at, started) = (now_ms(), Instant::now());
            let result = exec(&mut conn, sql, &[]).await;
            self.history.record(NewHistory {
                at,
                profile_id: profile.id.clone(),
                profile_name: profile.input.name.clone(),
                driver: driver_name(profile.input.driver).to_string(),
                variant: Some(variant_code(dialect.variant())),
                schema: req.catalog.clone(),
                sql: sql.clone(),
                elapsed_ms: Some(started.elapsed().as_millis() as u64),
                rows: result.as_ref().ok().copied(),
                error: result.as_ref().err().map(ToString::to_string),
            });
            report(&self.sessions.policy(), &ctx, sql, &result).await;
            if let Err(e) = result {
                outcome = Err(e);
                break;
            }
        }
        let _ = conn.close().await;
        self.metadata.cache().invalidate(&profile.id, None);
        outcome
    }

    /// 表空间列表。这个库没有表空间（MySQL 系、SQL Server 等）时返回空列表。
    pub async fn tablespaces(&self, profile_id: &str) -> Result<Vec<Tablespace>> {
        let profile = self.profile(profile_id)?;
        let dialect = self.metadata.dialect(&profile).await?;
        let queries = tablespace_queries(dialect.family());
        if queries.is_empty() {
            return Ok(vec![]);
        }
        let password = self.password(&profile.id).await?;
        let (mut conn, _) = self.registry.connect(&profile, password).await?;
        let mut last = None;
        for sql in queries {
            let rows = match conn.execute(sql, &[]).await {
                Ok(mut stream) => match collect_all(stream.as_mut(), 1000).await {
                    Ok(events) => MetaRows::from_events(events),
                    Err(e) => Err(e),
                },
                Err(e) => Err(e),
            };
            match rows {
                Ok(rows) => {
                    let _ = conn.close().await;
                    return Ok(rows
                        .iter()
                        .map(|r| Tablespace {
                            name: r.name("name"),
                            kind: r.text("kind"),
                            total: r.int("total"),
                            used: r.int("used"),
                        })
                        .collect());
                }
                // 没有 DBA 视图的权限、版本缺视图：换下一条
                Err(e) => last = Some(e),
            }
        }
        let _ = conn.close().await;
        Err(last.unwrap_or_else(|| Error::internal(msg!("namespace.tablespaces_failed"))))
    }
}
