//! MCP 服务（AI 设计文档“MCP”一节）：通过标准输入输出把 DATLUMA 交给本机的智能体（Claude Code、Codex、Cursor 等）。
//!
//! 只列出连接高级选项里打开了 `mcp_access` 的连接；工具只读：看结构，执行一条只读查询（最多 200 行，读完回滚）。
//! 密码照常从系统钥匙串取；用本地密码库保存的连接要先在 DATLUMA 里解锁不了，会报“已锁定”。

use std::sync::Arc;

use datluma_core::{Error, current_lang};
use datluma_dialect::meta::MetaKey;
use datluma_service::{Profile, Service};
use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{CallToolResult, ContentBlock};
use rmcp::{ServerHandler, ServiceExt, schemars, tool, tool_handler, tool_router};
use serde::Deserialize;
use serde_json::{Value, json};

/// 连接选项：允许 MCP 访问。
pub const OPT_MCP: &str = "mcp_access";
/// 一次查询最多返回的行数。
pub const MAX_ROWS: usize = 200;

pub fn mcp_allowed(p: &Profile) -> bool {
    p.input.options.get(OPT_MCP).is_some_and(|v| v == "1" || v == "true")
}

#[derive(Clone)]
pub struct DatlumaMcp {
    service: Arc<Service>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct ConnectionArg {
    /// Connection name or id, from list_connections.
    pub connection: String,
    /// SQL Server only: the database to work in. Omit for the connection's default.
    #[serde(default)]
    pub catalog: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct SchemaArg {
    /// Connection name or id, from list_connections.
    pub connection: String,
    /// SQL Server only: the database. Omit for the connection's default.
    #[serde(default)]
    pub catalog: Option<String>,
    /// Schema (MySQL: database) name, from list_schemas.
    pub schema: String,
    /// Optional case-insensitive substring of the table name.
    #[serde(default)]
    pub filter: Option<String>,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct TableArg {
    /// Connection name or id, from list_connections.
    pub connection: String,
    #[serde(default)]
    pub catalog: Option<String>,
    pub schema: String,
    pub table: String,
}

#[derive(Debug, Deserialize, schemars::JsonSchema)]
pub struct QueryArg {
    /// Connection name or id, from list_connections.
    pub connection: String,
    #[serde(default)]
    pub catalog: Option<String>,
    /// Exactly one read-only statement (SELECT, WITH, SHOW, EXPLAIN). Qualify table names with their schema.
    pub sql: String,
}

fn ok(v: Value) -> CallToolResult {
    CallToolResult::success(vec![ContentBlock::text(v.to_string())])
}

fn fail(e: &Error) -> CallToolResult {
    CallToolResult::error(vec![ContentBlock::text(e.to_msg().render(current_lang()))])
}

#[tool_router]
impl DatlumaMcp {
    pub fn new(service: Arc<Service>) -> Self {
        Self { service }
    }

    /// 按名字或 id 找打开了 MCP 访问的连接。
    fn connection(&self, name: &str, catalog: Option<&str>) -> Result<Profile, Error> {
        let all = self.service.profiles()?;
        let p = all
            .iter()
            .find(|p| p.id == name)
            .or_else(|| all.iter().find(|p| p.input.name == name))
            .or_else(|| all.iter().find(|p| p.input.name.eq_ignore_ascii_case(name)))
            .filter(|p| mcp_allowed(p))
            .ok_or_else(|| Error::NotFound { what: datluma_core::msg!("mcp.no_connection", name = name) })?;
        Ok(p.in_catalog(catalog.filter(|c| !c.is_empty())))
    }

    #[tool(description = "List the database connections the user allowed for MCP access.")]
    async fn list_connections(&self) -> CallToolResult {
        match self.service.profiles() {
            Ok(list) => ok(Value::Array(
                list.iter()
                    .filter(|p| mcp_allowed(p))
                    .map(|p| {
                        json!({
                            "id": p.id,
                            "name": p.input.name,
                            "driver": p.input.driver,
                            "product": p.input.product,
                            "database": p.input.database,
                            "environment": p.input.environment,
                        })
                    })
                    .collect(),
            )),
            Err(e) => fail(&e),
        }
    }

    #[tool(description = "List the schemas (MySQL: databases) of a connection, without system schemas.")]
    async fn list_schemas(&self, Parameters(a): Parameters<ConnectionArg>) -> CallToolResult {
        let run = async {
            let p = self.connection(&a.connection, a.catalog.as_deref())?;
            let list = self.service.metadata.schemas(&p, None).await?;
            Ok::<_, Error>(json!(
                list.into_iter().filter(|s| !s.is_system).map(|s| s.name).collect::<Vec<_>>()
            ))
        };
        run.await.map_or_else(|e| fail(&e), ok)
    }

    #[tool(description = "List the tables in a schema with their comments.")]
    async fn list_tables(&self, Parameters(a): Parameters<SchemaArg>) -> CallToolResult {
        let run = async {
            let p = self.connection(&a.connection, a.catalog.as_deref())?;
            let list =
                self.service.metadata.objects(&p, &a.schema, MetaKey::Tables, a.filter.as_deref()).await?;
            Ok::<_, Error>(json!(
                list.into_iter().map(|o| json!({"name": o.name, "comment": o.comment})).collect::<Vec<_>>()
            ))
        };
        run.await.map_or_else(|e| fail(&e), ok)
    }

    #[tool(
        description = "Describe a table: columns with types, nullability and comments, primary key, foreign keys and indexes."
    )]
    async fn describe_table(&self, Parameters(a): Parameters<TableArg>) -> CallToolResult {
        let run = async {
            let p = self.connection(&a.connection, a.catalog.as_deref())?;
            let tables = self.service.metadata.tables(&p, &a.schema, Some(&a.table)).await?;
            let t = tables.first().ok_or_else(|| Error::NotFound {
                what: datluma_core::msg!("mcp.no_connection", name = format!("{}.{}", a.schema, a.table)),
            })?;
            Ok::<_, Error>(CallToolResult::success(vec![ContentBlock::text(datluma_service::ai::table_text(
                t, true,
            ))]))
        };
        run.await.unwrap_or_else(|e| fail(&e))
    }

    #[tool(
        description = "Run exactly one read-only SQL statement (SELECT, WITH, SHOW, EXPLAIN) and return at most 200 rows. \
                          It runs in a transaction that is rolled back. Writes, DDL and multiple statements are rejected."
    )]
    async fn run_query(&self, Parameters(a): Parameters<QueryArg>) -> CallToolResult {
        let run = async {
            let p = self.connection(&a.connection, a.catalog.as_deref())?;
            let (columns, rows, more) = self.service.read_only_query(&p, &a.sql, MAX_ROWS).await?;
            Ok::<_, Error>(json!({"columns": columns, "rows": rows, "truncated": more}))
        };
        run.await.map_or_else(|e| fail(&e), ok)
    }
}

#[tool_handler(
    name = "datluma",
    instructions = "DATLUMA database tools. Start with list_connections. Everything is read-only."
)]
impl ServerHandler for DatlumaMcp {}

/// 在标准输入输出上提供 MCP 服务，直到对方断开。
pub async fn serve_stdio(service: Arc<Service>) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let running = DatlumaMcp::new(service).serve(rmcp::transport::stdio()).await?;
    running.waiting().await?;
    Ok(())
}

/// 在任意读写流上提供服务（测试用）。
pub async fn serve_io<R, W>(
    service: Arc<Service>,
    io: (R, W),
) -> Result<(), Box<dyn std::error::Error + Send + Sync>>
where
    R: tokio::io::AsyncRead + Send + Unpin + 'static,
    W: tokio::io::AsyncWrite + Send + Unpin + 'static,
{
    let running = DatlumaMcp::new(service).serve(io).await?;
    running.waiting().await?;
    Ok(())
}
