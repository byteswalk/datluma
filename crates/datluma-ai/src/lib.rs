//! 大模型提供方（AI 设计文档“提供方”一节）：发一段对话，拿回文本。不碰数据库，上下文由服务层组装。
//!
//! - `openai`：OpenAI 兼容的 `/chat/completions`（DeepSeek、通义千问、智谱、Kimi、Ollama、vLLM 等）；
//! - `anthropic`：`/v1/messages`；
//! - `cli`：本机智能体命令行的非交互模式，提示词从标准输入传入，读标准输出。

mod cli;

use std::time::Duration;

use datluma_core::{Error, Result, msg};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    #[default]
    Openai,
    Anthropic,
    Cli,
}

/// 提供方配置。API key 不在这里，单独存在密码库。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct ProviderConfig {
    pub enabled: bool,
    pub kind: ProviderKind,
    /// 接口地址，如 `https://api.deepseek.com`、`http://localhost:11434/v1`。`anthropic` 留空时用官方地址。
    pub base_url: String,
    pub model: String,
    /// `cli` 的命令行，如 `claude -p`、`codex exec -`。
    pub command: String,
    pub timeout_secs: u64,
}

impl Default for ProviderConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            kind: ProviderKind::Openai,
            base_url: String::new(),
            model: String::new(),
            command: String::new(),
            timeout_secs: 120,
        }
    }
}

impl ProviderConfig {
    /// 保存前检查必填项。
    pub fn validate(&self) -> Result<()> {
        if !self.enabled {
            return Ok(());
        }
        match self.kind {
            ProviderKind::Openai => {
                if self.base_url.trim().is_empty() {
                    return Err(Error::invalid(msg!("ai.base_url_required")));
                }
                if self.model.trim().is_empty() {
                    return Err(Error::invalid(msg!("ai.model_required")));
                }
            }
            ProviderKind::Anthropic => {
                if self.model.trim().is_empty() {
                    return Err(Error::invalid(msg!("ai.model_required")));
                }
            }
            ProviderKind::Cli => {
                if cli::split(&self.command).is_empty() {
                    return Err(Error::invalid(msg!("ai.command_required")));
                }
            }
        }
        if !(5..=1800).contains(&self.timeout_secs) {
            return Err(Error::invalid(msg!("ai.timeout_range")));
        }
        Ok(())
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(self.timeout_secs.clamp(5, 1800))
    }
}

/// 一次请求：系统提示和用户消息。
#[derive(Debug, Clone)]
pub struct Prompt {
    pub system: String,
    pub user: String,
}

/// 发出请求并返回模型的回答（去掉推理模型输出的 `<think>` 段）。
/// `allow_cli` 为 false 时拒绝命令行提供方（审计版、对外监听的服务器）。
pub async fn complete(
    cfg: &ProviderConfig,
    key: Option<&str>,
    prompt: &Prompt,
    allow_cli: bool,
) -> Result<String> {
    if !cfg.enabled {
        return Err(Error::invalid(msg!("ai.disabled")));
    }
    let text = match cfg.kind {
        ProviderKind::Openai => openai(cfg, key, prompt).await?,
        ProviderKind::Anthropic => anthropic(cfg, key, prompt).await?,
        ProviderKind::Cli => {
            if !allow_cli {
                return Err(Error::invalid(msg!("ai.cli_not_allowed")));
            }
            cli::run(&cfg.command, &format!("{}\n\n{}", prompt.system, prompt.user), cfg.timeout()).await?
        }
    };
    let text = strip_think(&text);
    if text.is_empty() {
        return Err(Error::internal(msg!("ai.empty_answer")));
    }
    Ok(text)
}

fn client(cfg: &ProviderConfig) -> Result<reqwest::Client> {
    reqwest::Client::builder()
        .timeout(cfg.timeout())
        .build()
        .map_err(|e| Error::internal(msg!("ai.client_failed", error = e)))
}

fn join(base: &str, path: &str) -> String {
    format!("{}/{}", base.trim().trim_end_matches('/'), path)
}

async fn openai(cfg: &ProviderConfig, key: Option<&str>, prompt: &Prompt) -> Result<String> {
    let body = json!({
        "model": cfg.model.trim(),
        "messages": [
            {"role": "system", "content": prompt.system},
            {"role": "user", "content": prompt.user},
        ],
        "temperature": 0.2,
        "stream": false,
    });
    let mut req = client(cfg)?.post(join(&cfg.base_url, "chat/completions"));
    if let Some(k) = key.filter(|k| !k.is_empty()) {
        req = req.bearer_auth(k);
    }
    let v = send(req, body).await?;
    v.pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| Error::internal(msg!("ai.bad_response")))
}

async fn anthropic(cfg: &ProviderConfig, key: Option<&str>, prompt: &Prompt) -> Result<String> {
    let base =
        if cfg.base_url.trim().is_empty() { "https://api.anthropic.com" } else { cfg.base_url.as_str() };
    let body = json!({
        "model": cfg.model.trim(),
        "max_tokens": 4096,
        "system": prompt.system,
        "messages": [{"role": "user", "content": prompt.user}],
    });
    let key = key.filter(|k| !k.is_empty()).ok_or_else(|| Error::invalid(msg!("ai.key_required")))?;
    let req = client(cfg)?
        .post(join(base, "v1/messages"))
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01");
    let v = send(req, body).await?;
    let parts =
        v.get("content").and_then(Value::as_array).ok_or_else(|| Error::internal(msg!("ai.bad_response")))?;
    Ok(parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join(""))
}

async fn send(req: reqwest::RequestBuilder, body: Value) -> Result<Value> {
    let resp =
        req.header("content-type", "application/json").body(body.to_string()).send().await.map_err(|e| {
            if e.is_timeout() { Error::Timeout } else { Error::connect(msg!("ai.unreachable", error = e)) }
        })?;
    let status = resp.status();
    let bytes = resp.bytes().await.map_err(|e| Error::connect(msg!("ai.unreachable", error = e)))?;
    if !status.is_success() {
        let detail = excerpt(&String::from_utf8_lossy(&bytes), 300);
        let message = msg!("ai.http_failed", status = status.as_u16(), body = detail);
        return Err(if status.as_u16() == 401 || status.as_u16() == 403 {
            Error::Auth { message }
        } else {
            Error::connect(message)
        });
    }
    serde_json::from_slice(&bytes).map_err(|_| Error::internal(msg!("ai.bad_response")))
}

/// 去掉推理模型（DeepSeek R1、Qwen3 等）回答开头的 `<think>…</think>`。
pub fn strip_think(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("<think>")
        && let Some(end) = rest.find("</think>")
    {
        return rest[end + "</think>".len()..].trim().to_owned();
    }
    t.to_owned()
}

/// 截取前 `max` 个字符，超出时加省略号。
pub fn excerpt(s: &str, max: usize) -> String {
    let s = s.trim();
    match s.char_indices().nth(max) {
        Some((i, _)) => format!("{}…", &s[..i]),
        None => s.to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::Router;
    use axum::http::{HeaderMap, StatusCode};
    use axum::routing::post;

    async fn serve(app: Router) -> String {
        let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = l.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(l, app).await.unwrap() });
        format!("http://{addr}")
    }

    fn prompt() -> Prompt {
        Prompt { system: "sys".into(), user: "hello".into() }
    }

    fn cfg(kind: ProviderKind, base: String) -> ProviderConfig {
        ProviderConfig { enabled: true, kind, base_url: base, model: "m1".into(), ..Default::default() }
    }

    #[tokio::test]
    async fn openai_sends_messages_and_key() {
        let app = Router::new().route(
            "/v1/chat/completions",
            post(|h: HeaderMap, body: String| async move {
                let v: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(h["authorization"], "Bearer k1");
                assert_eq!(v["model"], "m1");
                assert_eq!(v["messages"][0]["content"], "sys");
                assert_eq!(v["messages"][1]["content"], "hello");
                axum::Json(json!({"choices": [{"message": {"content": "<think>hmm</think>\nSELECT 1"}}]}))
            }),
        );
        let base = serve(app).await;
        let out =
            complete(&cfg(ProviderKind::Openai, format!("{base}/v1/")), Some("k1"), &prompt(), false).await;
        assert_eq!(out.unwrap(), "SELECT 1");
    }

    #[tokio::test]
    async fn anthropic_uses_header_key() {
        let app = Router::new().route(
            "/v1/messages",
            post(|h: HeaderMap, body: String| async move {
                let v: Value = serde_json::from_str(&body).unwrap();
                assert_eq!(h["x-api-key"], "k2");
                assert_eq!(v["system"], "sys");
                axum::Json(json!({"content": [{"type": "text", "text": "ok"}]}))
            }),
        );
        let base = serve(app).await;
        let out = complete(&cfg(ProviderKind::Anthropic, base), Some("k2"), &prompt(), false).await;
        assert_eq!(out.unwrap(), "ok");
    }

    #[tokio::test]
    async fn bad_key_is_auth_error() {
        let app = Router::new()
            .route("/chat/completions", post(|| async { (StatusCode::UNAUTHORIZED, "invalid api key") }));
        let base = serve(app).await;
        let err = complete(&cfg(ProviderKind::Openai, base), Some("x"), &prompt(), false).await.unwrap_err();
        assert!(matches!(err, Error::Auth { .. }), "{err:?}");
    }

    #[tokio::test]
    async fn disabled_and_cli_gate() {
        let mut c = cfg(ProviderKind::Cli, String::new());
        c.command = "sort".into();
        assert!(complete(&c, None, &prompt(), false).await.is_err());
        c.enabled = false;
        assert!(complete(&c, None, &prompt(), true).await.is_err());
    }

    #[tokio::test]
    async fn cli_reads_stdin() {
        let mut c = cfg(ProviderKind::Cli, String::new());
        c.command = "sort".into();
        let out = complete(&c, None, &prompt(), true).await.unwrap();
        assert!(out.contains("sys") && out.contains("hello"), "{out}");
    }

    #[test]
    fn validate_required_fields() {
        let mut c = cfg(ProviderKind::Openai, String::new());
        assert!(c.validate().is_err());
        c.base_url = "http://x".into();
        assert!(c.validate().is_ok());
        c.kind = ProviderKind::Cli;
        assert!(c.validate().is_err());
        c.enabled = false;
        assert!(c.validate().is_ok());
    }

    #[test]
    fn excerpt_counts_chars() {
        assert_eq!(excerpt("中文abc", 2), "中文…");
        assert_eq!(excerpt("ab", 5), "ab");
    }
}
