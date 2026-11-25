//! 新建、删除库和模式（对象树右键）。各库叫法和语句不同：
//! - MySQL 系：库就是模式，`CREATE DATABASE`，可带字符集、排序规则（GBase 8a 不带）；
//! - PG 系（含 openGauss、GaussDB、金仓、GBase 8c）：`CREATE SCHEMA`，可指定所有者；
//! - SQL Server：连接上建库 `CREATE DATABASE`，库里建架构 `CREATE SCHEMA`；
//! - 达梦：`CREATE SCHEMA … AUTHORIZATION 用户`；
//! - Oracle、OceanBase 的 Oracle 租户：模式随用户产生，这里不提供（新建用户在账号权限里）；
//! - SQLite、GBase 8s：不提供。
//!
//! 语句由这里生成，不接受前端拼好的 SQL；字符集、排序规则只放行字母、数字和下划线。

use datluma_core::{Error, Result, msg};
use serde::{Deserialize, Serialize};

use crate::{Dialect, Family, Variant};

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum NamespaceChange {
    CreateDatabase {
        name: String,
        #[serde(default)]
        charset: Option<String>,
        #[serde(default)]
        collation: Option<String>,
    },
    CreateSchema {
        name: String,
        #[serde(default)]
        owner: Option<String>,
    },
    DropDatabase {
        name: String,
    },
    DropSchema {
        name: String,
    },
}

impl NamespaceChange {
    pub fn name(&self) -> &str {
        match self {
            Self::CreateDatabase { name, .. }
            | Self::CreateSchema { name, .. }
            | Self::DropDatabase { name }
            | Self::DropSchema { name } => name,
        }
    }

    pub fn is_drop(&self) -> bool {
        matches!(self, Self::DropDatabase { .. } | Self::DropSchema { .. })
    }
}

/// 连接上能做什么。`database` 在连接上新建、删除库；`schema` 在连接（SQL Server 是库）上新建、删除模式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct NamespaceCaps {
    pub database: bool,
    pub schema: bool,
    /// 建库时能指定字符集和排序规则（MySQL 系）。
    pub charset: bool,
    /// 建模式时能指定所有者；`owner_required` 为真时必须指定（达梦）。
    pub owner: bool,
    pub owner_required: bool,
}

fn required(value: &str) -> Result<&str> {
    let v = value.trim();
    if v.is_empty() {
        return Err(Error::invalid(msg!("namespace.name_required")));
    }
    Ok(v)
}

/// 字符集、排序规则不是标识符：只放行字母、数字、下划线。
fn word(value: Option<&str>) -> Result<Option<&str>> {
    match value.map(str::trim).filter(|v| !v.is_empty()) {
        None => Ok(None),
        Some(v) if v.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') => Ok(Some(v)),
        Some(_) => Err(Error::invalid(msg!("namespace.bad_charset"))),
    }
}

impl Dialect {
    pub fn namespace_caps(&self) -> NamespaceCaps {
        let none = NamespaceCaps {
            database: false,
            schema: false,
            charset: false,
            owner: false,
            owner_required: false,
        };
        match self.family() {
            Family::MySql => {
                NamespaceCaps { database: true, charset: self.variant() != Variant::Gbase8a, ..none }
            }
            Family::Postgres => NamespaceCaps { schema: true, owner: true, ..none },
            Family::SqlServer => NamespaceCaps { database: true, schema: true, owner: true, ..none },
            Family::Dameng => NamespaceCaps { schema: true, owner: true, owner_required: true, ..none },
            Family::Oracle | Family::Sqlite | Family::Informix => none,
        }
    }

    pub fn namespace_statements(&self, change: &NamespaceChange) -> Result<Vec<String>> {
        let caps = self.namespace_caps();
        let unsupported = || Error::invalid(msg!("namespace.unsupported"));
        let sql = match change {
            NamespaceChange::CreateDatabase { name, charset, collation } => {
                if !caps.database {
                    return Err(unsupported());
                }
                let mut sql = format!("CREATE DATABASE {}", self.quote_ident(required(name)?));
                if caps.charset {
                    if let Some(c) = word(charset.as_deref())? {
                        sql.push_str(&format!(" CHARACTER SET {c}"));
                    }
                    if let Some(c) = word(collation.as_deref())? {
                        sql.push_str(&format!(" COLLATE {c}"));
                    }
                }
                sql
            }
            NamespaceChange::CreateSchema { name, owner } => {
                if !caps.schema {
                    return Err(unsupported());
                }
                let mut sql = format!("CREATE SCHEMA {}", self.quote_ident(required(name)?));
                match owner.as_deref().map(str::trim).filter(|o| !o.is_empty()) {
                    Some(o) => sql.push_str(&format!(" AUTHORIZATION {}", self.quote_ident(o))),
                    None if caps.owner_required => {
                        return Err(Error::invalid(msg!("namespace.owner_required")));
                    }
                    None => {}
                }
                sql
            }
            NamespaceChange::DropDatabase { name } => {
                if !caps.database {
                    return Err(unsupported());
                }
                format!("DROP DATABASE {}", self.quote_ident(required(name)?))
            }
            NamespaceChange::DropSchema { name } => {
                if !caps.schema {
                    return Err(unsupported());
                }
                let q = self.quote_ident(required(name)?);
                // SQL Server 的架构不能连对象一起删，非空时由数据库报错
                match self.family() {
                    Family::SqlServer => format!("DROP SCHEMA {q}"),
                    _ => format!("DROP SCHEMA {q} CASCADE"),
                }
            }
        };
        Ok(vec![sql])
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sql(v: Variant, c: &NamespaceChange) -> Result<Vec<String>> {
        Dialect::new(v).namespace_statements(c)
    }

    fn create_db(name: &str, charset: Option<&str>, collation: Option<&str>) -> NamespaceChange {
        NamespaceChange::CreateDatabase {
            name: name.into(),
            charset: charset.map(Into::into),
            collation: collation.map(Into::into),
        }
    }

    fn create_schema(name: &str, owner: Option<&str>) -> NamespaceChange {
        NamespaceChange::CreateSchema { name: name.into(), owner: owner.map(Into::into) }
    }

    #[test]
    fn databases_on_mysql_family_and_sql_server() {
        let c = create_db("app", Some("utf8mb4"), Some("utf8mb4_general_ci"));
        assert_eq!(
            sql(Variant::MySql, &c).unwrap(),
            ["CREATE DATABASE `app` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci"]
        );
        // GBase 8a 不带字符集
        assert_eq!(sql(Variant::Gbase8a, &c).unwrap(), ["CREATE DATABASE `app`"]);
        assert_eq!(
            sql(Variant::SqlServer, &create_db("app", None, None)).unwrap(),
            ["CREATE DATABASE [app]"]
        );
        assert_eq!(
            sql(Variant::MySql, &NamespaceChange::DropDatabase { name: "app".into() }).unwrap(),
            ["DROP DATABASE `app`"]
        );
        // 字符集只放行单词
        assert!(sql(Variant::MySql, &create_db("app", Some("utf8; DROP"), None)).is_err());
        assert!(sql(Variant::Postgres, &c).is_err(), "PG 这里只建模式");
    }

    #[test]
    fn schemas_by_family() {
        assert_eq!(sql(Variant::Postgres, &create_schema("app", None)).unwrap(), ["CREATE SCHEMA \"app\""]);
        assert_eq!(
            sql(Variant::OpenGauss, &create_schema("app", Some("u1"))).unwrap(),
            ["CREATE SCHEMA \"app\" AUTHORIZATION \"u1\""]
        );
        assert_eq!(
            sql(Variant::SqlServer, &create_schema("app", Some("dbo"))).unwrap(),
            ["CREATE SCHEMA [app] AUTHORIZATION [dbo]"]
        );
        assert_eq!(
            sql(Variant::Dameng, &create_schema("APP", Some("U1"))).unwrap(),
            ["CREATE SCHEMA \"APP\" AUTHORIZATION \"U1\""]
        );
        assert!(sql(Variant::Dameng, &create_schema("APP", None)).is_err(), "达梦要指定所有者");
        let drop = NamespaceChange::DropSchema { name: "app".into() };
        assert_eq!(sql(Variant::Postgres, &drop).unwrap(), ["DROP SCHEMA \"app\" CASCADE"]);
        assert_eq!(sql(Variant::SqlServer, &drop).unwrap(), ["DROP SCHEMA [app]"]);
    }

    #[test]
    fn oracle_sqlite_informix_have_none() {
        for v in [Variant::Oracle, Variant::OceanBaseOracle, Variant::Sqlite, Variant::Gbase8s] {
            let caps = Dialect::new(v).namespace_caps();
            assert!(!caps.database && !caps.schema, "{v:?}");
            assert!(sql(v, &create_schema("x", Some("u"))).is_err(), "{v:?}");
        }
        assert!(sql(Variant::MySql, &create_schema("x", None)).is_err());
        assert!(sql(Variant::Postgres, &create_schema(" ", None)).is_err());
    }
}
