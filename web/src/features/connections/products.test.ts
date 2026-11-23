import { describe, expect, it } from 'vitest'

import { PRODUCT_GROUPS, listedProduct } from './products'

describe('产品入口', () => {
  it('每个产品一个入口：OceanBase 不再分 MySQL、Oracle 两个', () => {
    const all = PRODUCT_GROUPS.flatMap((g) => g.products)
    expect(all).toContain('oceanbase')
    expect(all).not.toContain('oceanbase_oracle')
    expect(new Set(all).size).toBe(all.length)
  })

  it('Oracle 模式租户的连接归在 OceanBase 入口下', () => {
    expect(listedProduct('oceanbase_oracle')).toBe('oceanbase')
    expect(listedProduct('kingbase')).toBe('kingbase')
  })
})
