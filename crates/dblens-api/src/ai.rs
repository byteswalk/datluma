//! AI 接口（AI 设计文档“接口”一节）。
//!
//! 个人版由用户在设置里配置提供方；审计版的引擎在启动时用 `fix_provider` 固定配置，此后配置接口一律拒绝，
//! 也不读样例数据、不允许命令行提供方。

use std::sync::OnceLock;

use axum::Json;
use axum::extract::State;
use dblens_ai::{ProviderConfig, ProviderKind};
use dblens_core::{Error, msg};
use dblens_service::ai::{AiAccess, AskRequest, AskResponse};
use serde::{Deserialize, Serialize};

use crate::AppState;
use crate::error::ApiResult;

struct Fixed {
    config: ProviderConfig,
    key: Option<String>,
}

static FIXED: OnceLock<Fixed> = OnceLock::new();

/// 固定本进程的 AI 提供方（审计版引擎启动时调用一次）。之后配置接口拒绝修改。
pub fn fix_provider(config: ProviderConfig, key: Option<String>) {
    let _ = FIXED.set(Fixed { config, key });
}

fn fixed() -> Option<&'static Fixed> {
    FIXED.get()
}

/// 本次请求可用的提供方和数据边界。
fn resolve(s: &AppState) -> Result<(ProviderConfig, Option<String>, bool, bool), Error> {
    if let Some(f) = fixed() {
        return Ok((f.config.clone(), f.key.clone(), false, false));
    }
    let config = s.service.ai_config()?;
    let key = if config.enabled && config.kind != ProviderKind::Cli { s.service.ai_key()? } else { None };
    Ok((config, key, s.config.local_files, true))
}

#[derive(Serialize)]
pub struct ConfigView {
    pub config: ProviderConfig,
    pub has_key: bool,
    /// 用户能否修改（审计版为 false）。
    pub configurable: bool,
    /// 能否选命令行提供方（桌面版、只监听本机的服务器版）。
    pub cli_allowed: bool,
    /// 能否带样例数据（审计版为 false）。
    pub samples_allowed: bool,
}

pub async fn config(State(s): State<AppState>) -> ApiResult<Json<ConfigView>> {
    if let Some(f) = fixed() {
        // 审计版不把地址和模型给到浏览器，只说开没开
        let config = ProviderConfig { enabled: f.config.enabled, kind: f.config.kind, ..Default::default() };
        return Ok(Json(ConfigView {
            config,
            has_key: f.key.is_some(),
            configurable: false,
            cli_allowed: false,
            samples_allowed: false,
        }));
    }
    let config = s.service.ai_config()?;
    let has_key = s.service.secrets.has_app(dblens_service::ai::KEY_NAME)?;
    Ok(Json(ConfigView {
        config,
        has_key,
        configurable: true,
        cli_allowed: s.config.local_files,
        samples_allowed: true,
    }))
}

fn ensure_configurable(s: &AppState) -> Result<(), Error> {
    if fixed().is_some() {
        return Err(Error::Denied { reason: msg!("ai.config_locked") });
    }
    let _ = s;
    Ok(())
}

pub async fn set_config(
    State(s): State<AppState>,
    Json(cfg): Json<ProviderConfig>,
) -> ApiResult<Json<ConfigView>> {
    ensure_configurable(&s)?;
    if cfg.kind == ProviderKind::Cli && !s.config.local_files {
        return Err(Error::invalid(msg!("ai.cli_not_allowed")).into());
    }
    s.service.set_ai_config(&cfg)?;
    config(State(s)).await
}

#[derive(Deserialize)]
pub struct KeyBody {
    /// null 或空串表示删除。
    pub key: Option<String>,
}

pub async fn set_key(State(s): State<AppState>, Json(body): Json<KeyBody>) -> ApiResult<Json<ConfigView>> {
    ensure_configurable(&s)?;
    s.service.set_ai_key(body.key.as_deref())?;
    config(State(s)).await
}

#[derive(Serialize)]
pub struct TestReply {
    pub reply: String,
}

pub async fn test(State(s): State<AppState>) -> ApiResult<Json<TestReply>> {
    ensure_configurable(&s)?;
    let (config, key, allow_cli, allow_samples) = resolve(&s)?;
    let access = AiAccess { config: &config, key: key.as_deref(), allow_cli, allow_samples };
    Ok(Json(TestReply { reply: s.service.ai_test(&access).await? }))
}

pub async fn ask(State(s): State<AppState>, Json(req): Json<AskRequest>) -> ApiResult<Json<AskResponse>> {
    let (config, key, allow_cli, allow_samples) = resolve(&s)?;
    let access = AiAccess { config: &config, key: key.as_deref(), allow_cli, allow_samples };
    Ok(Json(s.service.ai_ask(&access, req).await?))
}
