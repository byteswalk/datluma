import { describe, expect, it } from 'vitest'

import { VARIANT_ICONS, dbIcon } from './dbIcons'

// 后端 Variant 的全部序列化名称（crates/dblens-dialect/src/variant.rs）
const VARIANTS = [
  'mysql',
  'mariadb',
  'tidb',
  'oceanbase',
  'oceanbase_oracle',
  'goldendb',
  'polardb',
  'postgres',
  'kingbase',
  'opengauss',
  'gaussdb',
  'highgo',
  'oracle',
  'dameng',
  'sqlserver',
  'gbase8s',
  'gbase8a',
  // 产品，不是变体：新建连接的列表用
  'gbase',
  'gbase8c',
  'sqlite',
]

describe('数据库图标', () => {
  it('每个变体都有图标：官方 logo 或官方标识，其余是字标', () => {
    expect(Object.keys(VARIANT_ICONS).sort()).toEqual([...VARIANTS].sort())
    for (const v of ['mariadb', 'tidb', 'postgres', 'sqlite']) expect(VARIANT_ICONS[v].kind).toBe('logo')
    for (const v of ['mysql', 'oceanbase', 'kingbase', 'opengauss', 'oracle', 'sqlserver', 'highgo'])
      expect(VARIANT_ICONS[v].kind).toBe('art')
    // 达梦只有官网位图
    expect(VARIANT_ICONS.dameng.kind).toBe('image')
    expect(dbIcon('postgres', 'gaussdb').kind).toBe('logo')
    expect(dbIcon('mysql', 'goldendb')).toEqual({ kind: 'mark', text: 'GDB', color: '#c8873a' })
  })

  it('不知道变体时按驱动大类，认不出的变体也按驱动', () => {
    expect(dbIcon('postgres')).toBe(VARIANT_ICONS.postgres)
    expect(dbIcon('mysql', null)).toBe(VARIANT_ICONS.mysql)
    expect(dbIcon('oracle', 'something-new')).toBe(VARIANT_ICONS.oracle)
  })

  it('品牌色太深的 logo 在暗色主题下有提亮的颜色', () => {
    expect(VARIANT_ICONS.mariadb).toMatchObject({ kind: 'logo', color: '#003545', dark: '#c49a6c' })
    // 多色标识按图形单独提亮：MySQL 的蓝、瀚高的深色部分
    const mysql = VARIANT_ICONS.mysql
    expect(mysql.kind === 'art' && mysql.shapes[0].dark).toBe('#6ba6d0')
    const highgo = VARIANT_ICONS.highgo
    expect(highgo.kind === 'art' && highgo.shapes.every((s) => s.fill === '#ec6c00' || s.dark)).toBe(true)
  })
})
