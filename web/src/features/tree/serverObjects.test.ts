import { describe, expect, it } from 'vitest'

import { formatBytes, hasServerObjects, hasTablespaces, namespaceCaps, tablespaceExtra } from './serverObjects'

describe('新建库、模式的能力', () => {
  it('MySQL 系建库，GBase 8a 不带字符集', () => {
    expect(namespaceCaps('mysql', 'mysql')).toMatchObject({ database: true, schema: false, charset: true })
    expect(namespaceCaps('mysql', 'gbase8a')).toMatchObject({ database: true, charset: false })
  })

  it('PG 系建模式，SQL Server 两样都有，达梦必须指定所有者', () => {
    expect(namespaceCaps('postgres', 'opengauss')).toMatchObject({ database: false, schema: true, owner: true })
    expect(namespaceCaps('sqlserver', null)).toMatchObject({ database: true, schema: true })
    expect(namespaceCaps('dameng', 'dameng')).toMatchObject({ schema: true, owner_required: true })
  })

  it('Oracle、SQLite、GBase 8s 都不提供', () => {
    for (const d of ['oracle', 'sqlite', 'informix'] as const) {
      const c = namespaceCaps(d, null)
      expect(c.database || c.schema).toBe(false)
    }
  })
})

describe('服务器对象', () => {
  it('SQLite 没有用户；表空间只有 Oracle、达梦、PG 系', () => {
    expect(hasServerObjects('sqlite')).toBe(false)
    expect(hasServerObjects('mysql')).toBe(true)
    expect(hasTablespaces('oracle')).toBe(true)
    expect(hasTablespaces('mysql')).toBe(false)
  })

  it('表空间大小写成已用 / 总量', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB')
    expect(tablespaceExtra({ name: 'USERS', kind: 'PERMANENT', total: 2 * 1024 ** 3, used: 1024 ** 3 })).toBe('1.0 GB / 2.0 GB')
    expect(tablespaceExtra({ name: 'pg_default', kind: null, total: null, used: 200 * 1024 ** 2 })).toBe('200 MB')
    expect(tablespaceExtra({ name: 'X', kind: null, total: null, used: null })).toBeUndefined()
  })
})
