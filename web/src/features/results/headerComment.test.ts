import { describe, expect, it } from 'vitest'

import { buildComments, commentOf } from './headerComment'

describe('列头注释', () => {
  it('按列名找注释，不分大小写', () => {
    const c = buildComments([{ name: 'MODEL_NO', comment: '模型编号' }])
    expect(commentOf(c, 'model_no')).toBe('模型编号')
    expect(commentOf(c, 'MODEL_NO')).toBe('模型编号')
    expect(commentOf(undefined, 'MODEL_NO')).toBeUndefined()
  })

  it('空注释不算', () => {
    const c = buildComments([{ name: 'a', comment: '  ' }, { name: 'b', comment: null }, { name: 'c' }])
    expect(c.size).toBe(0)
  })

  it('同名列注释不同时不显示，相同时照常显示', () => {
    const c = buildComments([
      { name: 'id', comment: '订单号' },
      { name: 'ID', comment: '客户号' },
      { name: 'id', comment: '订单号' },
      { name: 'name', comment: '名称' },
      { name: 'name', comment: '名称' },
    ])
    expect(commentOf(c, 'id')).toBeUndefined()
    expect(commentOf(c, 'name')).toBe('名称')
  })

  it('一张表有注释、另一张没有时用有的', () => {
    const c = buildComments([{ name: 'amount', comment: null }, { name: 'amount', comment: '金额' }])
    expect(commentOf(c, 'AMOUNT')).toBe('金额')
  })
})
