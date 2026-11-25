// 对象树上的"服务器对象"（用户、角色、表空间）和新建 / 删除库、模式：哪些库有哪些，菜单怎么叫。纯逻辑，单独测试。
// 规则和后端 datluma-dialect 的 namespace.rs、namespace 服务的表空间查询一致；后端还会再校验一次。

import type { DriverId, NamespaceCaps, Tablespace } from '../../shared/api'

/** 新建、删除库或模式的能力，按驱动和识别出的变体判断（不用连库）。 */
export function namespaceCaps(driver: DriverId | undefined, variant: string | null | undefined): NamespaceCaps {
  const none: NamespaceCaps = { database: false, schema: false, charset: false, owner: false, owner_required: false }
  switch (driver) {
    case 'mysql':
      return { ...none, database: true, charset: variant !== 'gbase8a' }
    case 'postgres':
      return { ...none, schema: true, owner: true }
    case 'sqlserver':
      return { ...none, database: true, schema: true, owner: true }
    case 'dameng':
      return { ...none, schema: true, owner: true, owner_required: true }
    default:
      return none
  }
}

/** 连接下有没有"服务器对象"（用户、角色）：SQLite 没有账号。 */
export function hasServerObjects(driver: DriverId | undefined): boolean {
  return driver !== undefined && driver !== 'sqlite'
}

/** 有没有表空间：Oracle、达梦、PG 系有；OceanBase 的 Oracle 租户只列名字，也算。 */
export function hasTablespaces(driver: DriverId | undefined): boolean {
  return driver === 'oracle' || driver === 'dameng' || driver === 'postgres'
}

/** 字节数写成 KB、MB、GB。 */
export function formatBytes(n: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/** 表空间节点后面的说明：已用 / 总量；PG 只有已用；读不到大小时为空。 */
export function tablespaceExtra(ts: Tablespace): string | undefined {
  if (ts.used !== null && ts.total !== null) return `${formatBytes(ts.used)} / ${formatBytes(ts.total)}`
  if (ts.total !== null) return formatBytes(ts.total)
  if (ts.used !== null) return formatBytes(ts.used)
  return undefined
}

/** MySQL 系建库时字符集下拉里的常用项（也可以直接输入）。 */
export const COMMON_CHARSETS = ['utf8mb4', 'utf8mb3', 'utf8', 'gbk', 'gb18030', 'latin1']
