import { describe, expect, it } from 'vitest'

import { supportsDatabaseList } from './DatabaseInput'

describe('数据库下拉', () => {
  it('MySQL 系、PG 系、SQL Server 能从服务器列出库', () => {
    expect(supportsDatabaseList({ driver: 'mysql', product: 'tidb' })).toBe(true)
    expect(supportsDatabaseList({ driver: 'postgres', product: 'gaussdb' })).toBe(true)
    expect(supportsDatabaseList({ driver: 'sqlserver', product: 'sqlserver' })).toBe(true)
  })

  it('Oracle、达梦、GBase、SQLite 和 OceanBase 的 Oracle 租户不列', () => {
    expect(supportsDatabaseList({ driver: 'oracle', product: 'oracle' })).toBe(false)
    expect(supportsDatabaseList({ driver: 'oracle', product: 'oceanbase_oracle' })).toBe(false)
    expect(supportsDatabaseList({ driver: 'dameng', product: 'dameng' })).toBe(false)
    expect(supportsDatabaseList({ driver: 'informix', product: 'gbase8s' })).toBe(false)
    expect(supportsDatabaseList({ driver: 'sqlite', product: 'sqlite' })).toBe(false)
  })
})
