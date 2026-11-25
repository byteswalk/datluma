//! AI 接口：配置、API key、连通测试、按任务提问。提供方用本地起的假 OpenAI 兼容服务。

use std::sync::{Arc, Mutex};

use axum::Router;
use axum::body::Body;
use axum::http::{Request, StatusCode, header};
use datluma_api::{ApiConfig, router};
use datluma_service::fake::FakeDriver;
use datluma_service::{DefaultPolicy, DriverRegistry, SecretBackend, Secrets, Service, Store};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;

fn app(local_files: bool) -> Router {
    let store = Arc::new(Store::open_in_memory().unwrap());
    let secrets = Arc::new(Secrets::with_backend(store.clone(), SecretBackend::Vault));
    secrets.init_vault("m").unwrap();
    let registry = Arc::new(DriverRegistry::with_drivers(
        store.clone(),
        vec![Box::new(FakeDriver { log: Arc::default() })],
    ));
    let service = Arc::new(Service::with_parts(store, secrets, registry, Arc::new(DefaultPolicy)));
    router(
        service,
        ApiConfig { token: "t".into(), allowed_origins: vec![], local_files, max_result_rows: None },
    )
}

async fn call(app: &Router, method: &str, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut req = Request::builder().method(method).uri(uri).header(header::AUTHORIZATION, "Bearer t");
    if body.is_some() {
        req = req.header(header::CONTENT_TYPE, "application/json");
    }
    let req = req.body(body.map_or_else(Body::empty, |b| Body::from(b.to_string()))).unwrap();
    let resp = app.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let bytes = resp.into_body().collect().await.unwrap().to_bytes();
    (status, if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap() })
}

type Seen = Arc<Mutex<Vec<(Option<String>, Value)>>>;

/// 假的 OpenAI 兼容服务：记下收到的 Authorization 和请求体，回答固定文字。
async fn fake_provider(answer: &'static str) -> (String, Seen) {
    let seen: Seen = Arc::default();
    let s = seen.clone();
    let app = axum::Router::new().route(
        "/v1/chat/completions",
        axum::routing::post(move |headers: axum::http::HeaderMap, axum::Json(body): axum::Json<Value>| {
            let s = s.clone();
            async move {
                let auth = headers.get("authorization").and_then(|v| v.to_str().ok()).map(str::to_owned);
                s.lock().unwrap().push((auth, body));
                axum::Json(json!({"choices": [{"message": {"content": answer}}]}))
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (format!("http://{addr}/v1"), seen)
}

fn openai(base: &str) -> Value {
    json!({"enabled": true, "kind": "openai", "base_url": base, "model": "m1", "timeout_secs": 30})
}

#[tokio::test]
async fn config_and_key_round_trip() {
    let app = app(false);
    let (st, v) = call(&app, "GET", "/api/ai/config", None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["config"]["enabled"], false);
    assert_eq!(
        (v["has_key"].clone(), v["configurable"].clone(), v["cli_allowed"].clone()),
        (json!(false), json!(true), json!(false))
    );

    // 服务器版不允许命令行提供方
    let cli = json!({"enabled": true, "kind": "cli", "command": "codex exec", "timeout_secs": 30});
    let (st, v) = call(&app, "PUT", "/api/ai/config", Some(cli)).await;
    assert_eq!((st, v["kind"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid")));
    // 启用 OpenAI 但没填地址
    let bad = json!({"enabled": true, "kind": "openai", "model": "m", "timeout_secs": 30});
    assert_eq!(call(&app, "PUT", "/api/ai/config", Some(bad)).await.0, StatusCode::BAD_REQUEST);

    let (st, v) = call(&app, "PUT", "/api/ai/config", Some(openai("http://x/v1"))).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(v["config"]["model"], "m1");

    let (_, v) = call(&app, "PUT", "/api/ai/key", Some(json!({"key": "  sk-1  "}))).await;
    assert_eq!(v["has_key"], true);
    // key 不会出现在任何回答里
    assert!(!call(&app, "GET", "/api/ai/config", None).await.1.to_string().contains("sk-1"));
    assert!(!call(&app, "GET", "/api/settings", None).await.1.to_string().contains("ai."));
    let (_, v) = call(&app, "PUT", "/api/ai/key", Some(json!({"key": null}))).await;
    assert_eq!(v["has_key"], false);
}

#[tokio::test]
async fn cli_allowed_on_local_server() {
    let app = app(true);
    assert_eq!(call(&app, "GET", "/api/ai/config", None).await.1["cli_allowed"], true);
    let cli = json!({"enabled": true, "kind": "cli", "command": "codex exec", "timeout_secs": 30});
    assert_eq!(call(&app, "PUT", "/api/ai/config", Some(cli)).await.0, StatusCode::OK);
}

#[tokio::test]
async fn test_and_ask_reach_provider_with_key() {
    let (base, seen) = fake_provider("原因是少了逗号。\n```sql\nSELECT a, b FROM t\n```").await;
    let app = app(false);
    call(&app, "PUT", "/api/ai/config", Some(openai(&base))).await;
    call(&app, "PUT", "/api/ai/key", Some(json!({"key": "sk-test"}))).await;

    let (st, v) = call(&app, "POST", "/api/ai/test", None).await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert!(v["reply"].as_str().unwrap().contains("逗号"));

    let (_, p) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(json!({"profile": {"name": "p", "driver": "postgres", "host": "h", "port": 5432, "user": "u"}, "password": "pw"})),
    )
    .await;
    let id = p["id"].as_str().unwrap().to_owned();
    let (st, v) = call(
        &app,
        "POST",
        "/api/ai/ask",
        Some(json!({"task": "fix", "profile_id": id, "sql": "SELECT a b FROM t", "error": "syntax error at b"})),
    )
    .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["sql"], "SELECT a, b FROM t");

    let seen = seen.lock().unwrap();
    assert_eq!(seen.len(), 2);
    assert_eq!(seen[1].0.as_deref(), Some("Bearer sk-test"));
    assert_eq!(seen[1].1["model"], "m1");
    let user = seen[1].1["messages"][1]["content"].as_str().unwrap();
    assert!(user.contains("SELECT a b FROM t") && user.contains("syntax error at b"), "{user}");
    // 带着识别出的数据库类型
    assert!(seen[1].1["messages"][0]["content"].as_str().unwrap().contains("Postgres"));
}

#[tokio::test]
async fn ask_needs_enabled_provider_and_fields() {
    let app = app(false);
    let (_, p) = call(
        &app,
        "POST",
        "/api/profiles",
        Some(json!({"profile": {"name": "p", "driver": "postgres", "host": "h", "port": 5432, "user": "u"}, "password": "pw"})),
    )
    .await;
    let id = p["id"].as_str().unwrap().to_owned();
    let (st, _) = call(
        &app,
        "POST",
        "/api/ai/ask",
        Some(json!({"task": "explain", "profile_id": id, "sql": "SELECT 1"})),
    )
    .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "未启用");
    call(&app, "PUT", "/api/ai/config", Some(openai("http://127.0.0.1:9/v1"))).await;
    let (st, _) = call(&app, "POST", "/api/ai/ask", Some(json!({"task": "explain", "profile_id": id}))).await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "缺语句");
    let (st, _) =
        call(&app, "POST", "/api/ai/ask", Some(json!({"task": "comments", "profile_id": id, "tables": []})))
            .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "表数");
}
