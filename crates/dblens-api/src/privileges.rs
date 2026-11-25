//! 数据库账号与权限接口（M9 设计文档第 7 节）。

use axum::Json;
use axum::extract::{Path, Query, State};
use dblens_dialect::privilege::PrivChange;
use dblens_service::{
    ObjectAccessReport, PrincipalPrivileges, PrivApplyResult, PrivPreview, PrivilegeOverview,
};
use serde::Deserialize;

use crate::AppState;
use crate::error::ApiResult;

#[derive(Deserialize)]
pub struct CatalogQuery {
    catalog: Option<String>,
}

#[derive(Deserialize)]
pub struct PrincipalQuery {
    principal: String,
    catalog: Option<String>,
}

#[derive(Deserialize)]
pub struct ObjectQuery {
    schema: String,
    object: String,
    catalog: Option<String>,
}

#[derive(Deserialize)]
pub struct ChangeBody {
    #[serde(default)]
    catalog: Option<String>,
    change: PrivChange,
    /// 生产连接上的高风险操作要带主体名。
    #[serde(default)]
    confirm_name: Option<String>,
}

pub async fn preview(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<ChangeBody>,
) -> ApiResult<Json<PrivPreview>> {
    Ok(Json(s.service.privilege_preview(&id, b.catalog.as_deref(), &b.change).await?))
}

pub async fn apply(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<ChangeBody>,
) -> ApiResult<Json<PrivApplyResult>> {
    let result =
        s.service.privilege_apply(&id, b.catalog.as_deref(), &b.change, b.confirm_name.as_deref()).await?;
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct BatchBody {
    #[serde(default)]
    catalog: Option<String>,
    changes: Vec<PrivChange>,
    #[serde(default)]
    confirm_name: Option<String>,
}

/// 一组修改一起预览（权限矩阵、建用户时一并授予的角色和权限）。
pub async fn preview_batch(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<BatchBody>,
) -> ApiResult<Json<PrivPreview>> {
    Ok(Json(s.service.privilege_preview_batch(&id, b.catalog.as_deref(), &b.changes).await?))
}

pub async fn apply_batch(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Json(b): Json<BatchBody>,
) -> ApiResult<Json<PrivApplyResult>> {
    let result = s
        .service
        .privilege_apply_batch(&id, b.catalog.as_deref(), &b.changes, b.confirm_name.as_deref())
        .await?;
    Ok(Json(result))
}

pub async fn overview(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<CatalogQuery>,
) -> ApiResult<Json<PrivilegeOverview>> {
    Ok(Json(s.service.privilege_overview(&id, q.catalog.as_deref()).await?))
}

pub async fn principal(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<PrincipalQuery>,
) -> ApiResult<Json<PrincipalPrivileges>> {
    Ok(Json(s.service.principal_privileges(&id, q.catalog.as_deref(), &q.principal).await?))
}

pub async fn object(
    State(s): State<AppState>,
    Path(id): Path<String>,
    Query(q): Query<ObjectQuery>,
) -> ApiResult<Json<ObjectAccessReport>> {
    Ok(Json(s.service.object_access(&id, q.catalog.as_deref(), &q.schema, &q.object).await?))
}
