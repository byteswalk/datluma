import { describe, expect, it } from 'vitest'

import { isSchemaField, supportsDatabaseList } from './DatabaseInput'

describe('数据库下拉', () => {
  it('MySQL 系、PG 系、SQL Server 能从服务器列出库', () => {
    expect(supportsDatabaseList({ driver: 'mysql', product: 'tidb' })).toBe(true)
    expect(supportsDatabaseList({ driver: 'postgres', product: 'gaussdb' })).toBe(true)
    expect(supportsDatabaseList({ driver: 'sqlserver', product: 'sqlserver' })).toBe(true)
  })

  it('达梦和 OceanBase 的 Oracle 租户列模式', () => {
    expect(supportsDatabaseList({ driver: 'dameng', product: 'dameng' })).toBe(true)
    expect(supportsDatabaseList({ driver: 'oracle', product: 'oceanbase_oracle' })).toBe(true)
    expect(isSchemaField({ driver: 'dameng', product: 'dameng' })).toBe(true)
    expect(isSchemaField({ driver: 'mysql', product: 'mysql' })).toBe(false)
  })

  it('Oracle、GBase、SQLite 不列', () => {
    expect(supportsDatabaseList({ driver: 'oracle', product: 'oracle' })).toBe(false)
    expect(supportsDatabaseList({ driver: 'informix', product: 'gbase8s' })).toBe(false)
    expect(supportsDatabaseList({ driver: 'sqlite', product: 'sqlite' })).toBe(false)
  })
})
