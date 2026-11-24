// 新建连接时按产品选（国产库第一批设计 4.3 节）：每个产品对应一个驱动、一个默认端口。
// 选择记在连接配置的 `product` 上；连上后以识别出的变体为准。

import type { DriverId } from '../../shared/api'
import { t } from '../../shared/i18n'

export type ProductId =
  | 'mysql'
  | 'mariadb'
  | 'tidb'
  | 'oceanbase'
  | 'oceanbase_oracle'
  | 'goldendb'
  | 'postgres'
  | 'kingbase'
  | 'opengauss'
  | 'gaussdb'
  | 'oracle'
  | 'dameng'
  | 'sqlserver'
  | 'gbase8s'
  | 'gbase8a'
  | 'gbase8c'
  | 'sqlite'

export interface Product {
  id: ProductId
  driver: DriverId
  port: number
}

export const PRODUCTS: Product[] = [
  { id: 'mysql', driver: 'mysql', port: 3306 },
  { id: 'mariadb', driver: 'mysql', port: 3306 },
  { id: 'tidb', driver: 'mysql', port: 4000 },
  { id: 'oceanbase', driver: 'mysql', port: 2881 },
  { id: 'oceanbase_oracle', driver: 'oracle', port: 2881 },
  { id: 'goldendb', driver: 'mysql', port: 8880 },
  { id: 'postgres', driver: 'postgres', port: 5432 },
  { id: 'kingbase', driver: 'postgres', port: 54321 },
  { id: 'opengauss', driver: 'postgres', port: 5432 },
  { id: 'gaussdb', driver: 'postgres', port: 8000 },
  { id: 'oracle', driver: 'oracle', port: 1521 },
  { id: 'dameng', driver: 'dameng', port: 5236 },
  { id: 'sqlserver', driver: 'sqlserver', port: 1433 },
  { id: 'gbase8s', driver: 'informix', port: 9088 },
  { id: 'gbase8a', driver: 'mysql', port: 5258 },
  // 内核是 openGauss，连上后按 openGauss 识别
  { id: 'gbase8c', driver: 'postgres', port: 5432 },
  // 本机文件，没有端口；只有桌面版可用
  { id: 'sqlite', driver: 'sqlite', port: 0 },
]

/**
 * 界面上的分组：国产库一组，其他一组。每个产品一个入口，兼容模式连上后自动识别。
 * OceanBase 也只有一个入口：Oracle 模式租户先按 MySQL 连会被拒绝，后端随即改走 JDBC，并把连接配置改成 `oceanbase_oracle`。
 */
export const PRODUCT_GROUPS: { key: 'domestic' | 'other'; products: ProductId[] }[] = [
  { key: 'domestic', products: ['dameng', 'kingbase', 'gaussdb', 'opengauss', 'oceanbase', 'goldendb', 'tidb', 'gbase8s'] },
  { key: 'other', products: ['mysql', 'mariadb', 'postgres', 'oracle', 'sqlserver', 'sqlite'] },
]

/** 产品连上后识别出的变体：GBase 8c 是 openGauss，其他产品与变体同名。 */
export function productVariant(id: ProductId): string {
  return id === 'gbase8c' ? 'opengauss' : id
}

/** GBase 的三个型号：协议各不相同（8s 走 JDBC、8a 走 MySQL、8c 走 PG），列表里只有一个 GBase 入口，表单里选型号。 */
export const GBASE_MODELS: ProductId[] = ['gbase8s', 'gbase8a', 'gbase8c']

export function isGbase(id: ProductId): boolean {
  return GBASE_MODELS.includes(id)
}

/** 列表里对应的入口：OceanBase 的 Oracle 模式租户归在 OceanBase 下，GBase 的型号都归在 GBase（用 8s 代表）下。 */
export function listedProduct(id: ProductId): ProductId {
  if (id === 'oceanbase_oracle') return 'oceanbase'
  return isGbase(id) ? 'gbase8s' : id
}

/** 列表里显示的名称和图标：GBase 的入口不带型号。 */
export function listLabel(id: ProductId): string {
  return isGbase(id) ? t('connections.product.gbase.label') : productLabel(id)
}

export function listIcon(id: ProductId): string {
  return isGbase(id) ? 'gbase' : id
}

export function product(id: ProductId): Product {
  return PRODUCTS.find((p) => p.id === id) ?? PRODUCTS[0]
}

/** 只有驱动、没有记下产品（较早保存的连接）时对应的产品。 */
export function baseProduct(driver: DriverId): ProductId {
  return driver === 'informix' ? 'gbase8s' : driver
}

/** 连接配置上记的产品；不认识的值按驱动处理。 */
export function productOf(driver: DriverId, saved?: string | null): ProductId {
  const p = PRODUCTS.find((x) => x.id === saved && x.driver === driver)
  return p ? p.id : baseProduct(driver)
}

export function productLabel(id: ProductId): string {
  return t(`connections.product.${id}.label`)
}

/** 产品的说明：默认端口以外的登录提示、需要的客户端库等；没有时为空串。 */
export function productNote(id: ProductId): string {
  return t(`connections.product.${id}.note`, { defaultValue: '' })
}
