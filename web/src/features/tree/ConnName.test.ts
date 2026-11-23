import { describe, expect, it } from 'vitest'

import { connHost, connKind } from './ConnName'

describe('连接名的悬停提示', () => {
  it('标准库显示产品名，不带"系"', () => {
    expect(connKind({ driver: 'postgres', product: 'postgres' })).toBe('PostgreSQL')
    expect(connKind({ driver: 'mysql', product: null })).toBe('MySQL')
  })

  it('选了具体产品时按产品，识别出变体时按识别结果', () => {
    expect(connKind({ driver: 'postgres', product: 'gaussdb' })).toBe('GaussDB')
    expect(connKind({ driver: 'postgres', product: 'opengauss', variant: 'kingbase' })).toBe('KingbaseES')
  })

  it('没有主机时按本机', () => {
    expect(connHost({ host: '' })).toBe('127.0.0.1')
    expect(connHost({ host: ' 10.0.0.8 ' })).toBe('10.0.0.8')
  })
})
