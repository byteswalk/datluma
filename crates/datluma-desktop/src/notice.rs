//! 提示框由页面按主题绘制，不用系统原生的消息框（检查更新、关于等）。
//!
//! 原生这边把提示放进待处理列表，并通过事件 [`EVENT`] 推给页面；页面显示后用 `notice_reply` 回传用户点了哪个按钮。
//! 页面刚启动、还没开始监听时推出的提示（如启动后的自动检查更新）不会丢：页面加载后用 `notice_pending` 取一次。

use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::{App, AppHandle, Emitter, Manager};
use tokio::sync::oneshot;

/// 新提示事件名，载荷为 [`Notice`]。
pub const EVENT: &str = "datluma://notice";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Kind {
    Info,
    Error,
}

/// 一条提示。`ok`/`cancel` 有值时是二选一的确认框，否则只有一个"确定"。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Notice {
    pub id: u64,
    pub kind: Kind,
    pub text: String,
    pub ok: Option<String>,
    pub cancel: Option<String>,
}

#[derive(Default)]
struct Pending {
    next: AtomicU64,
    open: Mutex<BTreeMap<u64, (Notice, oneshot::Sender<bool>)>>,
}

pub fn init(app: &App) {
    app.manage(Pending::default());
}

/// 让页面显示提示，等用户关闭后返回是否点了确认按钮。
pub async fn show(app: &AppHandle, kind: Kind, text: String, buttons: Option<(String, String)>) -> bool {
    let pending = app.state::<Pending>();
    let id = pending.next.fetch_add(1, Ordering::SeqCst) + 1;
    let (ok, cancel) = buttons.map_or((None, None), |(o, c)| (Some(o), Some(c)));
    let notice = Notice { id, kind, text, ok, cancel };
    let (tx, rx) = oneshot::channel();
    pending.open.lock().unwrap().insert(id, (notice.clone(), tx));
    if let Err(e) = app.emit(EVENT, &notice) {
        tracing::warn!("推送提示失败：{e}");
    }
    rx.await.unwrap_or(false)
}

/// 页面加载后取还没处理的提示。
#[tauri::command]
pub fn notice_pending(app: AppHandle) -> Vec<Notice> {
    app.state::<Pending>().open.lock().unwrap().values().map(|(n, _)| n.clone()).collect()
}

/// 页面回传用户的选择。
#[tauri::command]
pub fn notice_reply(app: AppHandle, id: u64, ok: bool) {
    if let Some((_, tx)) = app.state::<Pending>().open.lock().unwrap().remove(&id) {
        let _ = tx.send(ok);
    }
}
