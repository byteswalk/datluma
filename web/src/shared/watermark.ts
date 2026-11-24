// 斜向平铺的文字水印：生成一张 SVG 图块，用作 CSS 背景（background-repeat: repeat）。
// 生产连接的编辑区铺这个水印，见 QueryView 和 shell.css 的 .prod-watermark。
// 图块里放两处、错开半格（砖块式排列），不像网格那样整齐成行；每处是两行：醒目些的标题和更小的连接名。

const TILE_W = 440
const TILE_H = 260

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c] ?? c)
}

// 子元素的 fill-opacity 会覆盖外层的值而不是相乘，所以两行各自给出不透明度
function mark(x: number, y: number, title: string, subtitle: string, opacity: number): string {
  return (
    `<g transform="rotate(-18 ${x} ${y})">` +
    `<text x="${x}" y="${y - 8}" font-size="15" font-weight="500" letter-spacing="3" fill-opacity="${opacity}">${escapeXml(title)}</text>` +
    `<text x="${x}" y="${y + 12}" font-size="11" letter-spacing="1" fill-opacity="${opacity * 0.8}">${escapeXml(subtitle)}</text>` +
    `</g>`
  )
}

/** 返回可直接放进 `background-image` 的 `url("data:…")`。 */
export function watermarkImage(title: string, subtitle: string, color = '#d33b3b', opacity = 0.11): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE_W}" height="${TILE_H}">` +
    `<g fill="${color}" text-anchor="middle" dominant-baseline="middle" ` +
    `font-family="Microsoft YaHei, PingFang SC, Noto Sans CJK SC, sans-serif">` +
    mark(TILE_W / 4, TILE_H / 4, title, subtitle, opacity) +
    mark((TILE_W * 3) / 4, (TILE_H * 3) / 4, title, subtitle, opacity) +
    `</g></svg>`
  return `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`
}
