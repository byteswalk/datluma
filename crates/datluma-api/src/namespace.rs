//! 新建、删除库和模式，以及表空间列表（对象树右键和"服务器对象"）。

use axum::Json;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use datluma_dialect::NamespaceCaps;
use datluma_service::{NamespacePreview, NamespaceRequest, Tablespace};

use crate::AppState;
use crate::error::ApiResult;

pub async fn caps(State(s): State<AppState>, Path(id): Path<String>) -> ApiResult<Json<NamespaceCaps>> {
    Ok(Json(s.service.namespace_caps(&id).await?))
}

pub async fn preview(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<NamespaceRequest>,
) -> ApiResult<Json<NamespacePreview>> {
    Ok(Json(s.service.namespace_preview(&id, &req).await?))
}

pub async fn apply(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(req): Json<NamespaceRequest>,
) -> ApiResult<StatusCode> {
    s.service.namespace_apply(&id, &req).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn tablespaces(
    State(s): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<Json<Vec<Tablespace>>> {
    Ok(Json(s.service.tablespaces(&id).await?))
}
