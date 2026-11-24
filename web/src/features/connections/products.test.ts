import { describe, expect, it } from 'vitest'

import { emptyForm, isLoopback, switchProduct, validate } from './form'
import { PRODUCT_GROUPS, listIcon, listedProduct, productVariant } from './products'

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

  it('GBase 的三个型号在列表里是一个入口，连上后 8c 按 openGauss 识别', () => {
    const all = PRODUCT_GROUPS.flatMap((g) => g.products)
    expect(all.filter((p) => p.startsWith('gbase'))).toEqual(['gbase8s'])
    for (const id of ['gbase8s', 'gbase8a', 'gbase8c'] as const) {
      expect(listedProduct(id)).toBe('gbase8s')
      expect(listIcon(id)).toBe('gbase')
    }
    expect(productVariant('gbase8c')).toBe('opengauss')
    expect(productVariant('gbase8a')).toBe('gbase8a')
  })
})

describe('本机环境', () => {
  it('只认本机地址；远程主机选本机时保存报错，选开发等不报', () => {
    for (const h of ['127.0.0.1', '127.9.9.9', 'localhost', 'LOCALHOST', '::1', '[::1]']) expect(isLoopback(h)).toBe(true)
    for (const h of ['192.168.139.106', 'db.local', '127.0.0.1.example.com', '0.0.0.0']) expect(isLoopback(h)).toBe(false)
    const f = { ...switchProduct(emptyForm(), 'mysql'), name: 'n', user: 'u', host: '192.168.139.106', environment: 'none' as const }
    expect(validate(f).environment).toContain('192.168.139.106')
    expect(validate({ ...f, environment: 'dev' }).environment).toBeUndefined()
    expect(validate({ ...f, host: '127.0.0.1' }).environment).toBeUndefined()
  })
})
