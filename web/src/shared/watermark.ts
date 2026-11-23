// 斜向平铺的文字水印：生成一张 SVG 图块，用作 CSS 背景（background-repeat: repeat）。
// 生产连接的编辑区铺这个水印，见 QueryView 和 shell.css 的 .prod-watermark。

const TILE_W = 320
const TILE_H = 180

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c)
}

/** 返回可直接放进 `background-image` 的 `url("data:…")`。 */
export function watermarkImage(text: string, color = '#d33b3b', opacity = 0.09): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}">` +
    `<text x="${TILE_W / 2}" y="${TILE_H / 2}" fill="${color}" fill-opacity="${opacity}" font-size="18" font-weight="600" ` +
    `font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif" text-anchor="middle" dominant-baseline="middle" ` +
    `transform="rotate(-24 ${TILE_W / 2} ${TILE_H / 2})">${escapeXml(text)}</text></svg>`
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`
}
