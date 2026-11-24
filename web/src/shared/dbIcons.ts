// 数据库图标（M1i 设计文档第 6 节）：simple-icons 有的用它的官方 logo（CC0），多色或要调色的用 dbIconArt.ts 中的矢量标识，
// 只有位图的用官网图片（达梦），都没有合适图形的才用品牌主色加字标。图标只用来标识连接类型。

import { siHuawei, siMariadb, siPostgresql, siSqlite, siTidb } from 'simple-icons'

import type { DriverId } from './api'
import { ART_ICONS, type ArtIcon } from './dbIconArt'
import damengPng from './db-icons/dameng.png'

export type DbIconDef =
  /** 官方 logo：24×24 的 SVG 路径。`dark` 是暗色主题下的颜色（品牌色太深时提亮）。 */
  | { kind: 'logo'; path: string; color: string; dark?: string }
  /** 官方标识：多色，自带颜色。 */
  | ({ kind: 'art' } & ArtIcon)
  /** 字标：圆角方形底板上的缩写字母。 */
  | { kind: 'mark'; text: string; color: string }
  /** 官网的位图标识（没有矢量图时）。 */
  | { kind: 'image'; src: string }

const logo = (icon: { path: string; hex: string }, dark?: string): DbIconDef => ({
  kind: 'logo',
  path: icon.path,
  color: `#${icon.hex}`,
  dark,
})
const mark = (text: string, color: string): DbIconDef => ({ kind: 'mark', text, color })
const art = (icon: ArtIcon): DbIconDef => ({ kind: 'art', ...icon })
const image = (src: string): DbIconDef => ({ kind: 'image', src })

/** 按变体（后端 `Variant` 的序列化名称）。 */
export const VARIANT_ICONS: Record<string, DbIconDef> = {
  mysql: art(ART_ICONS.mysql),
  mariadb: logo(siMariadb, '#c49a6c'),
  tidb: logo(siTidb),
  oceanbase: art(ART_ICONS.oceanbase),
  oceanbase_oracle: art(ART_ICONS.oceanbase),
  // 官网图标是“金篆”两个字，16px 看不清：保留字标，用它的金色
  goldendb: mark('GDB', '#c8873a'),
  polardb: mark('PDB', '#ff6a00'),
  postgres: logo(siPostgresql, '#7f9cf0'),
  kingbase: art(ART_ICONS.kingbase),
  opengauss: art(ART_ICONS.opengauss),
  gaussdb: logo(siHuawei, '#ff4d55'),
  highgo: art(ART_ICONS.highgo),
  oracle: art(ART_ICONS.oracle),
  dameng: image(damengPng),
  sqlserver: art(ART_ICONS.sqlserver),
  // GBase 官网的品牌红；官网图标是红圆加很小的字，16px 看不清，用字标
  gbase8s: mark('8s', '#e60012'),
  gbase8a: mark('8a', '#e60012'),
  // 新建连接列表里的产品图标：GBase 的入口、8c 型号（连上后是 openGauss）
  gbase: mark('GB', '#e60012'),
  gbase8c: mark('8c', '#e60012'),
  sqlite: logo(siSqlite, '#4fa9de'),
}

/** 还没连接过、不知道具体变体时，按驱动大类。 */
const DRIVER_ICONS: Record<DriverId, string> = {
  mysql: 'mysql',
  postgres: 'postgres',
  oracle: 'oracle',
  dameng: 'dameng',
  sqlserver: 'sqlserver',
  informix: 'gbase8s',
  sqlite: 'sqlite',
}

export function dbIcon(driver: DriverId, variant?: string | null): DbIconDef {
  return (variant && VARIANT_ICONS[variant]) || VARIANT_ICONS[DRIVER_ICONS[driver]]
}
