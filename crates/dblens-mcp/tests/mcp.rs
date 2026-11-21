//! MCP 协议：按行收发 JSON-RPC，检查只列出允许的连接、只读查询的限制。

use std::sync::Arc;

use dblens_service::fake::FakeDriver;
use dblens_service::{DefaultPolicy, DriverRegistry, ProfileInput, SecretBackend, Secrets, Service, Store};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

fn service() -> Arc<Service> {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let secrets = Arc::new(Secrets::with_backend(store.clone(), SecretBackend::Vault));
    secrets.init_vault("m").unwrap();
    let registry = Arc::new(DriverRegistry::with_drivers(
        store.clone(),
        vec![Box::new(FakeDriver { log: Arc::default() })],
    ));
    let s = Arc::new(Service::with_parts(store, secrets, registry, Arc::new(DefaultPolicy)));
    let input = |name: &str, mcp: bool| {
        let mut v = json!({"name": name, "driver": "postgres", "host": "h", "port": 5432, "user": "u"});
        if mcp {
            v["options"] = json!({"mcp_access": "1"});
        }
        serde_json::from_value::<ProfileInput>(v).unwrap()
    };
    s.create_profile(input("open", true), Some("pw")).unwrap();
    s.create_profile(input("hidden", false), Some("pw")).unwrap();
    s
}

struct Client {
    w: tokio::io::WriteHalf<tokio::io::DuplexStream>,
    r: BufReader<tokio::io::ReadHalf<tokio::io::DuplexStream>>,
    id: i64,
}

impl Client {
    async fn send(&mut self, v: Value) {
        self.w.write_all(format!("{v}\n").as_bytes()).await.unwrap();
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.id += 1;
        let id = self.id;
        self.send(json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})).await;
        loop {
            let mut line = String::new();
            assert!(self.r.read_line(&mut line).await.unwrap() > 0, "服务端断开");
            let v: Value = serde_json::from_str(&line).unwrap();
            if v["id"] == id {
                return v;
            }
        }
    }

    async fn tool(&mut self, name: &str, args: Value) -> (bool, String) {
        let v = self.call("tools/call", json!({"name": name, "arguments": args})).await;
        let r = &v["result"];
        (
            r["isError"].as_bool().unwrap_or(false),
            r["content"][0]["text"].as_str().unwrap_or_default().to_owned(),
        )
    }
}

async fn start() -> Client {
    let (ours, theirs) = tokio::io::duplex(1 << 16);
    let (r, w) = tokio::io::split(theirs);
    tokio::spawn(dblens_mcp::serve_io(service(), (r, w)));
    let (r, w) = tokio::io::split(ours);
    let mut c = Client { w, r: BufReader::new(r), id: 0 };
    let init = c
        .call(
            "initialize",
            json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "1"}}),
        )
        .await;
    assert_eq!(init["result"]["serverInfo"]["name"], "dblens", "{init}");
    c.send(json!({"jsonrpc": "2.0", "method": "notifications/initialized"})).await;
    c
}

#[tokio::test]
async fn lists_tools_and_only_allowed_connections() {
    let mut c = start().await;
    let tools = c.call("tools/list", json!({})).await;
    let mut names: Vec<&str> =
        tools["result"]["tools"].as_array().unwrap().iter().map(|t| t["name"].as_str().unwrap()).collect();
    names.sort();
    assert_eq!(names, ["describe_table", "list_connections", "list_schemas", "list_tables", "run_query"]);

    let (err, text) = c.tool("list_connections", json!({})).await;
    assert!(!err);
    let list: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(list.as_array().unwrap().len(), 1);
    assert_eq!(list[0]["name"], "open");

    let (err, text) = c.tool("run_query", json!({"connection": "hidden", "sql": "SELECT ROWS 1"})).await;
    assert!(err && text.contains("hidden"), "{text}");
}

#[tokio::test]
async fn run_query_is_read_only_and_capped() {
    let mut c = start().await;
    let (err, text) = c.tool("run_query", json!({"connection": "open", "sql": "SELECT ROWS 250"})).await;
    assert!(!err, "{text}");
    let v: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(v["rows"].as_array().unwrap().len(), 200);
    assert_eq!(v["truncated"], true);

    for sql in ["DELETE FROM t", "SELECT 1; SELECT 2", "SELECT a INTO b FROM t", "DROP TABLE t"] {
        let (err, text) = c.tool("run_query", json!({"connection": "open", "sql": sql})).await;
        assert!(err, "{sql} 应被拒绝：{text}");
    }
}
