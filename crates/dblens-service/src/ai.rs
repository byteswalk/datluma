//! AI 辅助（AI 设计文档）：按任务从元数据组装上下文，交给提供方，解析回答。
//!
//! 数据边界只在这里控制：默认只发结构；样例数据只在 `comments` 任务、连接打开了 `ai_samples`、
//! 调用方也允许（审计版不允许）时才读，每表最多 5 行、每个值截到 50 个字符。

use std::collections::BTreeMap;

use dblens_ai::{Prompt, ProviderConfig, excerpt};
use dblens_core::schema::Table;
use dblens_core::{Error, Lang, Result, Value, current_lang, msg};
use dblens_dialect::Dialect;
use dblens_dialect::meta::MetaKey;
use dblens_driver::ExecEvent;
use serde::{Deserialize, Serialize};

use crate::profile::{Environment, Profile};
use crate::service::Service;

/// 本地库 `settings` 里保存提供方配置的键。
pub const CONFIG_KEY: &str = "ai.config";
/// 密码库里保存 API key 的名字。
pub const KEY_NAME: &str = "ai.key";
/// 连接选项：允许“补注释”带样例数据。
pub const OPT_SAMPLES: &str = "ai_samples";

const SAMPLE_ROWS: usize = 5;
const SAMPLE_CHARS: usize = 50;
/// 整个模式都发字段时的上限（字符数），超出后只发表名，再按问题里提到的表补字段。
const SCHEMA_BUDGET: usize = 24_000;
/// 按语句找出的表最多带几张。
const REFERENCED_LIMIT: usize = 12;
/// 补注释一次最多几张表。
pub const COMMENT_BATCH: usize = 10;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AiTask {
    Generate,
    Fix,
    Explain,
    Optimize,
    Convert,
    Comments,
    LintFix,
    /// 给审批人看的摘要：语句做什么、影响多大、风险和回退办法（审计版工单）。
    Review,
    /// 找出可能是敏感信息的列（审计版敏感列管理，管理员确认后才生效）。
    Sensitive,
}

/// 要转换的对象（结构迁移里没迁的视图、过程、触发器等）。
#[derive(Debug, Clone, Deserialize)]
pub struct AiObject {
    pub kind: String,
    pub name: String,
    pub definition: String,
}

/// 转换的目标库。
#[derive(Debug, Clone, Deserialize)]
pub struct AiTarget {
    /// 目标连接；给了就按它识别出的数据库类型，否则用 `product`。
    #[serde(default)]
    pub profile_id: Option<String>,
    #[serde(default)]
    pub product: Option<String>,
}

/// 规范检查的一条问题。
#[derive(Debug, Clone, Deserialize)]
pub struct AiIssue {
    pub object: String,
    pub message: String,
    #[serde(default)]
    pub suggestion: Option<String>,
    #[serde(default)]
    pub rule: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct AskRequest {
    pub task: AiTask,
    pub profile_id: String,
    #[serde(default)]
    pub catalog: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub sql: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub instruction: Option<String>,
    #[serde(default)]
    pub plan: Option<String>,
    #[serde(default)]
    pub object: Option<AiObject>,
    #[serde(default)]
    pub target: Option<AiTarget>,
    /// `comments`、`lint_fix` 针对的表。`comments` 可以给多张（最多 `COMMENT_BATCH`）。
    #[serde(default)]
    pub tables: Vec<String>,
    #[serde(default)]
    pub issue: Option<AiIssue>,
    /// `review`：系统已识别出的风险说明（规则命中、影响行数估计等）。
    #[serde(default)]
    pub risk: Option<String>,
}

/// 一个可能敏感的列。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SensitiveColumn {
    pub table: String,
    pub column: String,
    /// `personal`（姓名、证件号、手机号、地址等）、`credential`（密码、令牌、密钥）、`financial`（账号、卡号、金额）、`other`。
    pub category: String,
    #[serde(default)]
    pub reason: String,
}

/// 一张表的建议注释：只含原来空着的。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct TableComments {
    pub table: String,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub columns: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct AskResponse {
    /// 模型的完整回答（Markdown）。
    pub text: String,
    /// 回答里的第一段 SQL 代码。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sql: Option<String>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub comments: Vec<TableComments>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sensitive: Vec<SensitiveColumn>,
}

/// 调用方给定的提供方和数据边界。
pub struct AiAccess<'a> {
    pub config: &'a ProviderConfig,
    pub key: Option<&'a str>,
    /// 允许命令行提供方（桌面版、只监听本机的服务器版）。
    pub allow_cli: bool,
    /// 允许读样例数据（审计版为 false）。
    pub allow_samples: bool,
}

impl Service {
    /// 本地保存的提供方配置；没保存过时为默认（未启用）。
    pub fn ai_config(&self) -> Result<ProviderConfig> {
        match self.store.setting(CONFIG_KEY)? {
            Some(s) => serde_json::from_str(&s).map_err(|_| Error::internal(msg!("ai.bad_config"))),
            None => Ok(ProviderConfig::default()),
        }
    }

    pub fn set_ai_config(&self, cfg: &ProviderConfig) -> Result<()> {
        cfg.validate()?;
        let json = serde_json::to_string(cfg).map_err(|_| Error::internal(msg!("ai.bad_config")))?;
        self.store.set_setting(CONFIG_KEY, Some(&json))
    }

    pub fn ai_key(&self) -> Result<Option<String>> {
        self.secrets.get_app(KEY_NAME)
    }

    pub fn set_ai_key(&self, key: Option<&str>) -> Result<()> {
        match key.map(str::trim).filter(|k| !k.is_empty()) {
            Some(k) => self.secrets.set_app(KEY_NAME, k),
            None => self.secrets.delete_app(KEY_NAME),
        }
    }

    /// 发一句很短的问话，确认提供方可用。
    pub async fn ai_test(&self, access: &AiAccess<'_>) -> Result<String> {
        let prompt = Prompt {
            system: "You are a connectivity check.".into(),
            user: "Reply with the single word OK.".into(),
        };
        dblens_ai::complete(access.config, access.key, &prompt, access.allow_cli)
            .await
            .map(|t| excerpt(&t, 200))
    }

    pub async fn ai_ask(&self, access: &AiAccess<'_>, req: AskRequest) -> Result<AskResponse> {
        let profile = self.scoped_profile(&req.profile_id, req.catalog.as_deref())?;
        self.ai_ask_on(access, profile, req).await
    }

    /// 在调用方已取好的连接配置上提问（审计版引擎的内部接口：连接来自控制面，不按操作者过滤）。
    pub async fn ai_ask_on(
        &self,
        access: &AiAccess<'_>,
        profile: Profile,
        req: AskRequest,
    ) -> Result<AskResponse> {
        let dialect = self.metadata.dialect(&profile).await?;
        let db = db_label(&profile, &dialect);
        let schema = req.schema.clone().unwrap_or_default();
        let lang = answer_lang();
        let (system, user) = match req.task {
            AiTask::Generate => {
                let ask = need(&req.instruction)?;
                let ctx = self.schema_context(&profile, &schema, ask).await?;
                (
                    format!(
                        "You are a SQL expert for {db}. Write one SQL statement for the user's request using only the tables below. \
                         Put the SQL in a ```sql code block, then one or two sentences of explanation in {lang}. \
                         Do not invent tables or columns. Prefer read-only queries unless the user clearly asks to change data."
                    ),
                    format!("Current schema: {schema}\n\n{ctx}\n\nRequest:\n{ask}"),
                )
            }
            AiTask::Fix => {
                let sql = need(&req.sql)?;
                let error = need(&req.error)?;
                let ctx = self.referenced_context(&profile, &schema, sql, false).await?;
                (
                    format!(
                        "You are a SQL expert for {db}. The statement failed. Explain the cause briefly in {lang}, \
                         then give the corrected statement in a ```sql code block. Keep the user's intent; change as little as possible."
                    ),
                    format!("Current schema: {schema}\n\n{ctx}\n\nStatement:\n{sql}\n\nError:\n{error}"),
                )
            }
            AiTask::Explain => {
                let sql = need(&req.sql)?;
                let ctx = self.referenced_context(&profile, &schema, sql, false).await?;
                (
                    format!(
                        "You are a SQL expert for {db}. Explain in {lang} what the statement does, step by step, \
                         for a developer who did not write it. Mention anything risky (data changes, missing WHERE, locks). Do not rewrite it."
                    ),
                    format!("Current schema: {schema}\n\n{ctx}\n\nStatement:\n{sql}"),
                )
            }
            AiTask::Optimize => {
                let sql = need(&req.sql)?;
                let ctx = self.referenced_context(&profile, &schema, sql, true).await?;
                let plan = req
                    .plan
                    .as_deref()
                    .map(|p| format!("\n\nExecution plan:\n{}", excerpt(p, 8000)))
                    .unwrap_or_default();
                (
                    format!(
                        "You are a performance expert for {db}. Review the statement{} and the existing indexes. \
                         In {lang}, list concrete suggestions in order of impact. Put a rewritten statement and any CREATE INDEX statements \
                         in one ```sql code block. Say so plainly if the statement is already fine.",
                        if req.plan.is_some() { " with its execution plan" } else { "" }
                    ),
                    format!("Current schema: {schema}\n\n{ctx}\n\nStatement:\n{sql}{plan}"),
                )
            }
            AiTask::Convert => {
                let object = req
                    .object
                    .as_ref()
                    .ok_or_else(|| Error::invalid(msg!("ai.missing_field", field = "object")))?;
                let target = self.target_label(req.target.as_ref()).await?;
                (
                    format!(
                        "You are a database migration expert. Convert the {} below from {db} to {target}. \
                         Output the complete CREATE statement for {target} in one ```sql code block, then in {lang} list what you changed \
                         and anything that needs manual review. Keep object and column names.",
                        object.kind
                    ),
                    format!("{} {}:\n{}", object.kind, object.name, excerpt(&object.definition, 20_000)),
                )
            }
            AiTask::Comments => {
                return self.ai_comments(access, &profile, &dialect, &db, &schema, &req.tables, lang).await;
            }
            AiTask::Sensitive => {
                return self.ai_sensitive(access, &profile, &db, &schema, &req.tables, lang).await;
            }
            AiTask::Review => {
                let sql = need(&req.sql)?;
                let ctx = self.referenced_context(&profile, &schema, sql, true).await?;
                let risk = req
                    .risk
                    .as_deref()
                    .map(|r| {
                        format!(
                            "

Detected by the system:
{}",
                            excerpt(r, 4000)
                        )
                    })
                    .unwrap_or_default();
                (
                    format!(
                        "You help an approver review a change request on {db}. In {lang}, in at most 6 short lines \
                         starting with \"- \": what the statements do, which tables and roughly how many rows they affect, \
                         the main risks, and how to roll back. Be factual; do not invent row counts you cannot infer. \
                         Plain text only: no Markdown emphasis, headings or code blocks."
                    ),
                    format!(
                        "Current schema: {schema}

{ctx}

Statements:
{}{risk}",
                        excerpt(sql, 20_000)
                    ),
                )
            }
            AiTask::LintFix => {
                let issue = req
                    .issue
                    .as_ref()
                    .ok_or_else(|| Error::invalid(msg!("ai.missing_field", field = "issue")))?;
                let mut ctx = String::new();
                for t in req.tables.iter().take(1) {
                    if let Some(table) = self.metadata.tables(&profile, &schema, Some(t)).await?.first() {
                        ctx = table_text(table, true);
                    }
                }
                (
                    format!(
                        "You are a database design reviewer for {db}. In {lang}, explain why the issue matters and how to fix it. \
                         Put the statements that fix it in one ```sql code block. If it cannot be fixed by SQL, say what to do instead."
                    ),
                    format!(
                        "Current schema: {schema}\n\n{ctx}\n\nObject: {}\nRule: {}\nIssue: {}\nTool suggestion: {}",
                        issue.object,
                        issue.rule.as_deref().unwrap_or("-"),
                        issue.message,
                        issue.suggestion.as_deref().unwrap_or("-")
                    ),
                )
            }
        };
        // 小模型常忽略系统提示里的语言要求，问题末尾再说一次
        let user = format!("{user}\n\n(Answer in {lang}.)");
        let text = dblens_ai::complete(access.config, access.key, &Prompt { system, user }, access.allow_cli)
            .await?;
        let sql = sql_block(&text);
        Ok(AskResponse { text, sql, ..Default::default() })
    }

    #[allow(clippy::too_many_arguments)]
    async fn ai_comments(
        &self,
        access: &AiAccess<'_>,
        profile: &Profile,
        dialect: &Dialect,
        db: &str,
        schema: &str,
        names: &[String],
        lang: &str,
    ) -> Result<AskResponse> {
        if names.is_empty() || names.len() > COMMENT_BATCH {
            return Err(Error::invalid(msg!("ai.comment_batch", max = COMMENT_BATCH)));
        }
        let samples = access.allow_samples && samples_allowed(profile);
        let mut ctx = String::new();
        let mut wanted = Vec::new();
        for name in names {
            let Some(table) = self.metadata.tables(profile, schema, Some(name)).await?.into_iter().next()
            else {
                continue;
            };
            ctx.push_str(&table_text(&table, false));
            if samples {
                ctx.push_str(&self.sample_text(profile, dialect, schema, &table).await);
            }
            ctx.push('\n');
            wanted.push(table);
        }
        if wanted.is_empty() {
            return Err(Error::NotFound { what: msg!("ai.tables_not_found") });
        }
        let system = format!(
            "You are documenting a {db} database. For each table, infer a short comment for the table and for every column \
             whose comment is empty, from names, types{} and relationships. Write comments in {lang}, at most 30 characters each. \
             Reply with JSON only: {{\"tables\":[{{\"name\":\"<table>\",\"comment\":\"<table comment or null>\",\"columns\":{{\"<column>\":\"<comment>\"}}}}]}}. \
             Leave out columns that already have a comment.",
            if samples { ", sample rows" } else { "" }
        );
        let text =
            dblens_ai::complete(access.config, access.key, &Prompt { system, user: ctx }, access.allow_cli)
                .await?;
        let comments = parse_comments(&text, &wanted)?;
        Ok(AskResponse { text, sql: None, comments, sensitive: Vec::new() })
    }

    /// 按列名、类型和注释找出可能敏感的列（只发结构，不读数据）。
    async fn ai_sensitive(
        &self,
        access: &AiAccess<'_>,
        profile: &Profile,
        db: &str,
        schema: &str,
        names: &[String],
        lang: &str,
    ) -> Result<AskResponse> {
        if names.is_empty() || names.len() > COMMENT_BATCH {
            return Err(Error::invalid(msg!("ai.comment_batch", max = COMMENT_BATCH)));
        }
        let mut ctx = String::new();
        let mut wanted = Vec::new();
        for name in names {
            if let Some(table) = self.metadata.tables(profile, schema, Some(name)).await?.into_iter().next() {
                ctx.push_str(&table_text(&table, false));
                wanted.push(table);
            }
        }
        if wanted.is_empty() {
            return Err(Error::NotFound { what: msg!("ai.tables_not_found") });
        }
        let system = format!(
            "You classify columns of a {db} database that may hold sensitive data, from names, types and comments. \
             Categories: personal (names, ID numbers, phone, email, address, birthday), credential (passwords, tokens, keys), \
             financial (bank accounts, card numbers, salaries, balances), other. Only list columns that are likely sensitive; \
             timestamps, serial numbers and generic tags are not. Reply with JSON only: {{\"columns\":[{{\"table\":\"<table>\",\"column\":\"<column>\",\"category\":\"<category>\",\"reason\":\"<short reason in {lang}>\"}}]}}."
        );
        let text =
            dblens_ai::complete(access.config, access.key, &Prompt { system, user: ctx }, access.allow_cli)
                .await?;
        let sensitive = parse_sensitive(&text, &wanted)?;
        Ok(AskResponse { text, sql: None, comments: Vec::new(), sensitive })
    }

    /// 整个模式的结构；超出预算时只发表名，再按问题里提到的表补字段。
    async fn schema_context(&self, profile: &Profile, schema: &str, ask: &str) -> Result<String> {
        let tables = self.metadata.tables(profile, schema, None).await?;
        let full: String = tables.iter().map(|t| table_text(t, false)).collect();
        if full.len() <= SCHEMA_BUDGET {
            return Ok(full);
        }
        let mut out = String::from("All tables (name -- comment):\n");
        for t in &tables {
            out.push_str(&format!("  {}{}\n", t.name, comment_suffix(t.comment.as_deref())));
        }
        out.push_str("\nDetails of tables mentioned in the request:\n");
        let lower = ask.to_lowercase();
        let mut used = 0;
        for t in tables.iter().filter(|t| mentions(&lower, t)) {
            let text = table_text(t, false);
            if used + text.len() > SCHEMA_BUDGET {
                break;
            }
            used += text.len();
            out.push_str(&text);
        }
        Ok(out)
    }

    /// 语句里提到的表（按名字匹配当前模式的表），最多 `REFERENCED_LIMIT` 张。
    async fn referenced_context(
        &self,
        profile: &Profile,
        schema: &str,
        sql: &str,
        indexes: bool,
    ) -> Result<String> {
        if schema.is_empty() {
            return Ok(String::new());
        }
        let objects = self.metadata.objects(profile, schema, MetaKey::Tables, None).await?;
        let words = identifiers(sql);
        let mut out = String::new();
        for o in objects.iter().filter(|o| words.contains(&o.name.to_lowercase())).take(REFERENCED_LIMIT) {
            if let Some(t) = self.metadata.tables(profile, schema, Some(&o.name)).await?.first() {
                out.push_str(&table_text(t, indexes));
            }
        }
        Ok(out)
    }

    async fn target_label(&self, target: Option<&AiTarget>) -> Result<String> {
        let target = target.ok_or_else(|| Error::invalid(msg!("ai.missing_field", field = "target")))?;
        if let Some(id) = target.profile_id.as_deref().filter(|s| !s.is_empty()) {
            let p = self.profile(id)?;
            let d = self.metadata.dialect(&p).await?;
            return Ok(db_label(&p, &d));
        }
        target
            .product
            .clone()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| Error::invalid(msg!("ai.missing_field", field = "target")))
    }

    /// 读几行样例。读不到（权限、类型不支持等）时不影响补注释，返回空。
    async fn sample_text(&self, profile: &Profile, dialect: &Dialect, schema: &str, table: &Table) -> String {
        let sql = format!("SELECT * FROM {}", dialect.qualified(Some(schema), &table.name));
        match self.read_rows(profile, &sql, SAMPLE_ROWS).await {
            Ok((columns, rows)) if !rows.is_empty() => {
                let mut out = format!("  sample rows ({}):\n", columns.join(", "));
                for r in rows {
                    let cells: Vec<String> =
                        r.iter().map(|v| excerpt(&value_text(v), SAMPLE_CHARS)).collect();
                    out.push_str(&format!("    {}\n", cells.join(" | ")));
                }
                out
            }
            _ => String::new(),
        }
    }

    /// 在一条新连接上执行一条查询，最多读 `max_rows` 行。在事务中执行，读完回滚。
    /// 只供 AI 样例和 MCP 只读查询使用，调用方负责确认是只读语句（见 `read_only_query`）。
    pub async fn read_rows(
        &self,
        profile: &Profile,
        sql: &str,
        max_rows: usize,
    ) -> Result<(Vec<String>, Vec<Vec<Value>>)> {
        // 和编辑器里的查询一样过执行策略（审计版据此判定和留痕）
        let dialect = self.metadata.dialect(profile).await?;
        let ctx = crate::policy::ExecContext::new(profile, dialect, crate::policy::Operation::Editor);
        let policy = self.sessions.policy();
        if let Some(e) = crate::policy::ask(&policy, &ctx, sql).await.1.into_error() {
            return Err(e);
        }
        let password = self.password(&profile.id).await?;
        let (mut conn, _) = self.registry.connect(profile, password).await?;
        let result = async {
            // 不支持事务的驱动照常执行（语句已确认只读）
            let _ = conn.set_autocommit(false).await;
            let mut stream = conn.execute(sql, &[]).await?;
            let mut columns = Vec::new();
            let mut rows = Vec::new();
            while let Some(event) = stream.next(max_rows.max(1)).await? {
                match event {
                    ExecEvent::ResultStart { columns: c } if columns.is_empty() => {
                        columns = c.into_iter().map(|c| c.name).collect();
                    }
                    ExecEvent::Rows(batch) => {
                        rows.extend(batch.into_iter().take(max_rows - rows.len().min(max_rows)));
                        if rows.len() >= max_rows {
                            break;
                        }
                    }
                    ExecEvent::ResultEnd if !columns.is_empty() => break,
                    _ => {}
                }
            }
            drop(stream);
            Ok::<_, Error>((columns, rows))
        }
        .await;
        let _ = conn.rollback().await;
        let _ = conn.close().await;
        let n = result.as_ref().map(|(_, rows)| rows.len() as u64).map_err(Clone::clone);
        crate::policy::report(&policy, &ctx, sql, &n).await;
        result
    }

    /// 智能体的只读查询（MCP）：只能是一条只读语句（SELECT、WITH、SHOW、EXPLAIN 等），最多读 `max_rows` 行，
    /// 读完回滚。返回列名、行和是否还有更多。
    pub async fn read_only_query(
        &self,
        profile: &Profile,
        sql: &str,
        max_rows: usize,
    ) -> Result<(Vec<String>, Vec<Vec<Value>>, bool)> {
        let dialect = self.metadata.dialect(profile).await?;
        let statements = dialect.split(sql);
        let [one] = statements.as_slice() else {
            return Err(Error::invalid(msg!("mcp.one_statement")));
        };
        let info = crate::policy::classify(&dialect, &one.text);
        if info.kind != crate::policy::StatementKind::Dql || info.keyword == "SELECT" && has_into(&one.text) {
            return Err(Error::Denied { reason: msg!("mcp.read_only", keyword = info.keyword) });
        }
        let (columns, mut rows) = self.read_rows(profile, &one.text, max_rows + 1).await?;
        let more = rows.len() > max_rows;
        rows.truncate(max_rows);
        Ok((columns, rows, more))
    }
}

/// `SELECT … INTO` 会建表或写变量，不算只读。
fn has_into(sql: &str) -> bool {
    identifiers(sql).contains("into")
}

fn need(v: &Option<String>) -> Result<&str> {
    v.as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| Error::invalid(msg!("ai.missing_field", field = "sql/instruction/error")))
}

fn answer_lang() -> &'static str {
    match current_lang() {
        Lang::ZhCn => "Simplified Chinese",
        Lang::En => "English",
    }
}

/// 给模型看的数据库类型：驱动、识别出的变体和版本。
pub fn db_label(profile: &Profile, dialect: &Dialect) -> String {
    // 版本号内部编码为 major*10000 + minor*100 + patch
    let version = dialect
        .version()
        .map(|v| format!(" version {}.{}.{}", v / 10000, v / 100 % 100, v % 100))
        .unwrap_or_default();
    format!("{:?} ({:?}{version})", profile.input.driver, dialect.variant())
}

pub fn samples_allowed(profile: &Profile) -> bool {
    profile.input.options.get(OPT_SAMPLES).is_some_and(|v| v == "1" || v == "true")
}

/// 生产连接打开样例数据要再确认（界面用）。
pub fn samples_need_confirm(profile: &Profile) -> bool {
    profile.input.environment == Environment::Prod
}

fn comment_suffix(c: Option<&str>) -> String {
    c.filter(|c| !c.is_empty()).map(|c| format!("  -- {}", c.replace('\n', " "))).unwrap_or_default()
}

/// 一张表的紧凑描述：字段、主键、外键，`indexes` 时加索引。
pub fn table_text(t: &Table, indexes: bool) -> String {
    let pk: Vec<&str> =
        t.primary_key.as_ref().map(|p| p.columns.iter().map(String::as_str).collect()).unwrap_or_default();
    let mut out = format!("TABLE {}{}\n", t.name, comment_suffix(t.comment.as_deref()));
    for c in &t.columns {
        out.push_str(&format!(
            "  {} {}{}{}{}\n",
            c.name,
            c.data_type.native,
            if c.nullable { "" } else { " NOT NULL" },
            if pk.contains(&c.name.as_str()) { " PK" } else { "" },
            comment_suffix(c.comment.as_deref())
        ));
    }
    for fk in &t.foreign_keys {
        out.push_str(&format!(
            "  FK ({}) -> {}({})\n",
            fk.columns.join(", "),
            fk.ref_table,
            fk.ref_columns.join(", ")
        ));
    }
    if indexes {
        for i in &t.indexes {
            let cols: Vec<String> = i
                .columns
                .iter()
                .map(|c| if c.descending { format!("{} DESC", c.name) } else { c.name.clone() })
                .collect();
            out.push_str(&format!(
                "  {}INDEX {} ({})\n",
                if i.unique { "UNIQUE " } else { "" },
                i.name,
                cols.join(", ")
            ));
        }
    }
    out
}

fn mentions(lower_ask: &str, t: &Table) -> bool {
    let name = t.name.to_lowercase();
    lower_ask.contains(&name)
        || t.comment.as_deref().is_some_and(|c| {
            let c = c.trim();
            c.chars().count() >= 2 && lower_ask.contains(&c.to_lowercase())
        })
}

/// 语句中的标识符（小写，去掉引号），用来找涉及的表。
fn identifiers(sql: &str) -> std::collections::HashSet<String> {
    sql.split(|c: char| !(c.is_alphanumeric() || c == '_' || c == '$' || c == '#'))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

fn value_text(v: &Value) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        Ok(serde_json::Value::Null) => "NULL".into(),
        Ok(other) => other.to_string(),
        Err(_) => String::new(),
    }
}

/// 回答里的第一段 SQL 代码（```sql 或不带语言的代码块）。
pub fn sql_block(text: &str) -> Option<String> {
    let mut rest = text;
    while let Some(start) = rest.find("```") {
        let after = &rest[start + 3..];
        let (lang, body) = after.split_once('\n')?;
        let end = body.find("```")?;
        let code = body[..end].trim();
        let lang = lang.trim().to_lowercase();
        if (lang.is_empty() || lang == "sql" || lang.ends_with("sql")) && !code.is_empty() {
            return Some(code.to_owned());
        }
        rest = &body[end + 3..];
    }
    None
}

/// 回答中第一个 `{` 到最后一个 `}`。
fn json_part(text: &str) -> Result<&str> {
    let start = text.find('{').ok_or_else(|| Error::internal(msg!("ai.bad_json")))?;
    let end = text.rfind('}').ok_or_else(|| Error::internal(msg!("ai.bad_json")))?;
    if end < start {
        return Err(Error::internal(msg!("ai.bad_json")));
    }
    Ok(&text[start..=end])
}

/// 解析敏感列的 JSON；只保留确实存在的列，类别不认识的归为 other。
fn parse_sensitive(text: &str, tables: &[Table]) -> Result<Vec<SensitiveColumn>> {
    #[derive(Deserialize)]
    struct Reply {
        columns: Vec<SensitiveColumn>,
    }
    let reply: Reply =
        serde_json::from_str(json_part(text)?).map_err(|_| Error::internal(msg!("ai.bad_json")))?;
    let mut out = Vec::new();
    for c in reply.columns {
        let Some(t) = tables.iter().find(|t| t.name.eq_ignore_ascii_case(&c.table)) else { continue };
        let Some(col) = t.columns.iter().find(|x| x.name.eq_ignore_ascii_case(&c.column)) else { continue };
        let category = match c.category.as_str() {
            "personal" | "credential" | "financial" => c.category,
            _ => "other".into(),
        };
        if !out.iter().any(|o: &SensitiveColumn| o.table == t.name && o.column == col.name) {
            out.push(SensitiveColumn {
                table: t.name.clone(),
                column: col.name.clone(),
                category,
                reason: c.reason,
            });
        }
    }
    Ok(out)
}

/// 解析补注释的 JSON；只保留原来空着的注释和确实存在的字段。
fn parse_comments(text: &str, tables: &[Table]) -> Result<Vec<TableComments>> {
    #[derive(Deserialize)]
    struct Reply {
        tables: Vec<ReplyTable>,
    }
    #[derive(Deserialize)]
    struct ReplyTable {
        name: String,
        #[serde(default)]
        comment: Option<String>,
        #[serde(default)]
        columns: BTreeMap<String, String>,
    }
    let reply: Reply =
        serde_json::from_str(json_part(text)?).map_err(|_| Error::internal(msg!("ai.bad_json")))?;
    let empty = |c: &Option<String>| c.as_deref().is_none_or(|c| c.trim().is_empty());
    let mut out = Vec::new();
    for r in reply.tables {
        let Some(t) = tables.iter().find(|t| t.name.eq_ignore_ascii_case(&r.name)) else { continue };
        let comment =
            r.comment.filter(|c| !c.trim().is_empty() && empty(&t.comment)).map(|c| c.trim().to_owned());
        let columns = r
            .columns
            .into_iter()
            .filter_map(|(name, c)| {
                let col = t.columns.iter().find(|x| x.name.eq_ignore_ascii_case(&name))?;
                (empty(&col.comment) && !c.trim().is_empty()).then(|| (col.name.clone(), c.trim().to_owned()))
            })
            .collect();
        out.push(TableComments { table: t.name.clone(), comment, columns });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use dblens_core::schema::{Column, PrimaryKey};
    use dblens_core::{ColumnType, LogicalType};

    fn col(name: &str, comment: Option<&str>) -> Column {
        Column {
            name: name.into(),
            ordinal: 1,
            data_type: ColumnType { native: "int".into(), logical: LogicalType::Int { bits: 32 } },
            nullable: name != "id",
            default: None,
            comment: comment.map(Into::into),
            auto_increment: false,
            generated: None,
        }
    }

    fn table() -> Table {
        Table {
            name: "emp".into(),
            comment: None,
            columns: vec![col("id", None), col("dept_id", Some("部门"))],
            primary_key: Some(PrimaryKey { name: None, columns: vec!["id".into()] }),
            ..Default::default()
        }
    }

    #[test]
    fn table_text_is_compact() {
        assert_eq!(table_text(&table(), false), "TABLE emp\n  id int NOT NULL PK\n  dept_id int  -- 部门\n");
    }

    #[test]
    fn finds_sql_block() {
        assert_eq!(sql_block("说明\n```sql\nSELECT 1;\n```\n再说").as_deref(), Some("SELECT 1;"));
        assert_eq!(sql_block("```\nSELECT 2\n```").as_deref(), Some("SELECT 2"));
        assert_eq!(sql_block("```json\n{}\n```\n```sql\nSELECT 3\n```").as_deref(), Some("SELECT 3"));
        assert_eq!(sql_block("no code"), None);
    }

    #[test]
    fn comments_keep_only_empty_ones() {
        let text = r#"好的：```json
{"tables":[{"name":"EMP","comment":"员工","columns":{"id":"编号","dept_id":"别改","nope":"x"}}]}
```"#;
        let out = parse_comments(text, &[table()]).unwrap();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].table, "emp");
        assert_eq!(out[0].comment.as_deref(), Some("员工"));
        assert_eq!(out[0].columns.len(), 1);
        assert_eq!(out[0].columns["id"], "编号");
    }

    #[test]
    fn sensitive_keeps_existing_columns() {
        let text = r#"{"columns":[{"table":"emp","column":"ID","category":"personal","reason":"编号"},
            {"table":"emp","column":"nope","category":"personal"},{"table":"emp","column":"dept_id","category":"weird"}]}"#;
        let out = parse_sensitive(text, &[table()]).unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!((out[0].column.as_str(), out[0].category.as_str()), ("id", "personal"));
        assert_eq!(out[1].category, "other");
    }

    #[test]
    fn identifiers_are_lowercase_words() {
        let ids = identifiers(r#"select * from "Emp" e join dept_1 d on e.x=d.y"#);
        assert!(ids.contains("emp") && ids.contains("dept_1") && !ids.contains("e.x"));
    }
}
