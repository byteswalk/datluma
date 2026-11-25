//! 窗口位置和大小的计算（设计文档 7.2 节），不依赖 Tauri，单独测试。坐标和尺寸都是物理像素。

use serde::{Deserialize, Serialize};

/// 最小大小（逻辑像素）。
pub const MIN_SIZE: (f64, f64) = (1024.0, 640.0);

/// 默认窗口占屏幕面积的比例（黄金比例），宽高比 16:9。
const AREA_RATIO: f64 = 0.618;
const ASPECT: f64 = 16.0 / 9.0;

/// 窗口顶部这么高的条带算作标题栏。
const TITLE_BAR: i64 = 40;
/// 标题栏至少要有这么大的一块落在某个显示器的工作区内，用户才拖得动窗口。
const REACHABLE: (i64, i64) = (100, 20);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// 默认位置和大小：宽高比 16:9，面积是 `screen`（整个显示器）的 61.8%，中心对准屏幕中心。
/// 超出 `work_area`（去掉任务栏后的区域）时按比例缩小，再挪进工作区。
pub fn default_rect(screen: Rect, work_area: Rect) -> Rect {
    let area = f64::from(screen.width) * f64::from(screen.height) * AREA_RATIO;
    let mut height = (area / ASPECT).sqrt();
    let mut width = height * ASPECT;
    let shrink = (f64::from(work_area.width) / width).min(f64::from(work_area.height) / height).min(1.0);
    width = (width * shrink).round();
    height = (height * shrink).round();
    let center = |start: i32, len: u32, size: f64| f64::from(start) + (f64::from(len) - size) / 2.0;
    let clamp = |v: f64, start: i32, len: u32, size: f64| {
        v.min(f64::from(start) + f64::from(len) - size).max(f64::from(start)).round() as i32
    };
    Rect {
        x: clamp(center(screen.x, screen.width, width), work_area.x, work_area.width, width),
        y: clamp(center(screen.y, screen.height, height), work_area.y, work_area.height, height),
        width: width as u32,
        height: height as u32,
    }
}

/// 保存的窗口位置是否还能用：标题栏有足够大的一块落在某个显示器的工作区内。
/// 显示器被拔掉或分辨率变小后，返回 false，由调用方改用主屏幕上的默认位置。
pub fn is_reachable(rect: Rect, work_areas: &[Rect]) -> bool {
    let (left, top) = (i64::from(rect.x), i64::from(rect.y));
    let (right, bottom) = (left + i64::from(rect.width), top + TITLE_BAR.min(i64::from(rect.height)));
    work_areas.iter().any(|a| {
        let (al, at) = (i64::from(a.x), i64::from(a.y));
        let (ar, ab) = (al + i64::from(a.width), at + i64::from(a.height));
        let w = right.min(ar) - left.max(al);
        let h = bottom.min(ab) - top.max(at);
        w >= REACHABLE.0 && h >= REACHABLE.1
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(x: i32, y: i32, width: u32, height: u32) -> Rect {
        Rect { x, y, width, height }
    }

    #[test]
    fn default_is_16_9_golden_area_centered_on_screen() {
        // 1920×1080，任务栏在底部 40 像素：1509×849，面积约 61.8%，中心在屏幕中心
        let d = default_rect(r(0, 0, 1920, 1080), r(0, 0, 1920, 1040));
        assert_eq!(d, r(206, 116, 1509, 849));
        let ratio = f64::from(d.width * d.height) / f64::from(1920 * 1080);
        assert!((ratio - 0.618).abs() < 0.001, "{ratio}");
        // 副屏在主屏右边，2560×1440
        assert_eq!(
            default_rect(r(1920, 0, 2560, 1440), r(1920, 0, 2560, 1400)),
            r(1920 + 274, 154, 2012, 1132)
        );
    }

    #[test]
    fn default_keeps_16_9_on_other_screen_shapes() {
        // 16:10 的 2560×1600
        let d = default_rect(r(0, 0, 2560, 1600), r(0, 0, 2560, 1552));
        assert_eq!((d.width, d.height), (2121, 1193));
        assert_eq!((d.x, d.y), (220, 204));
    }

    #[test]
    fn default_shrinks_into_a_short_work_area() {
        // 超宽屏 3440×1440，但任务栏很高（工作区只剩 1000 高）：按比例缩小并挪进工作区
        let d = default_rect(r(0, 0, 3440, 1440), r(0, 0, 3440, 1000));
        assert_eq!(d.height, 1000);
        assert_eq!(d.width, 1778);
        assert_eq!(d.y, 0);
    }

    #[test]
    fn reachable_only_when_title_bar_is_on_some_monitor() {
        let monitors = [r(0, 0, 1920, 1040), r(1920, 0, 1920, 1040)];
        assert!(is_reachable(r(100, 100, 1440, 900), &monitors));
        assert!(is_reachable(r(2000, 100, 1440, 900), &monitors), "在副屏上");
        assert!(is_reachable(r(-1340, 100, 1440, 900), &monitors), "左边露出 100 像素");
        assert!(!is_reachable(r(-1400, 100, 1440, 900), &monitors), "只露出 40 像素");
        assert!(!is_reachable(r(4000, 100, 1440, 900), &monitors), "副屏已拔掉");
        assert!(!is_reachable(r(100, -500, 1440, 900), &monitors), "标题栏在屏幕上方");
        assert!(!is_reachable(r(100, 1030, 1440, 900), &monitors), "标题栏只露出 10 像素");
        assert!(!is_reachable(r(100, 100, 1440, 900), &[]));
    }
}
