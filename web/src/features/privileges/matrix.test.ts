import { describe, expect, it } from 'vitest'

import type { EffectivePrivilege, Principal, PrincipalRef, PrivilegeGrant } from '../../shared/api'
import {
  cellKey,
  cellState,
  directIndex,
  hasAll,
  inheritedIndex,
  objectTarget,
  orderedChanges,
  toggleCell,
  toggleMany,
  toggleMember,
  toggleRole,
  type Pending,
} from './matrix'

const me: PrincipalRef = { name: 'u', host: null, kind: 'user', level: 'server' }
const grant = (object: string, privilege: string, grantee = 'u'): PrivilegeGrant => ({
  grantee,
  scope: 'object',
  target: objectTarget('APP', object),
  privilege,
  effect: 'grant',
  grantable: false,
  grantor: null,
})

describe('权限矩阵', () => {
  const direct = directIndex([grant('ORDERS', 'SELECT')])
  const k = (o: string, p: string) => cellKey('object', objectTarget('app', o), p)

  it('格子的键不分大小写', () => {
    expect(direct.has(k('orders', 'select'))).toBe(true)
  })

  it('点未授予的格子是授予，再点一次撤销；点已授予的是回收', () => {
    let p: Pending = new Map()
    p = toggleCell(p, k('ORDERS', 'INSERT'), me, 'object', objectTarget('APP', 'ORDERS'), 'INSERT', direct, false)
    expect([...p.values()][0]).toMatchObject({ op: 'grant', privilege: 'INSERT' })
    expect(cellState(k('ORDERS', 'INSERT'), direct, undefined, new Map(), p)).toBe('adding')
    p = toggleCell(p, k('ORDERS', 'INSERT'), me, 'object', objectTarget('APP', 'ORDERS'), 'INSERT', direct, false)
    expect(p.size).toBe(0)
    p = toggleCell(p, k('ORDERS', 'SELECT'), me, 'object', objectTarget('APP', 'ORDERS'), 'SELECT', direct, false)
    expect([...p.values()][0]).toMatchObject({ op: 'revoke', privilege: 'SELECT' })
    expect(cellState(k('ORDERS', 'SELECT'), direct, undefined, new Map(), p)).toBe('removing')
  })

  it('整行全选：有没勾上的就全部勾上，全勾上了就全部去掉', () => {
    const cells = ['SELECT', 'INSERT'].map((priv) => ({ key: k('ORDERS', priv), scope: 'object' as const, target: objectTarget('APP', 'ORDERS'), privilege: priv }))
    const on = toggleMany(new Map(), cells, me, direct, false)
    expect([...on.values()].map((c) => c.op)).toEqual(['grant'])
    const both = directIndex([grant('ORDERS', 'SELECT'), grant('ORDERS', 'INSERT')])
    const off = toggleMany(new Map(), cells, me, both, false)
    expect([...off.values()].map((c) => c.op)).toEqual(['revoke', 'revoke'])
  })

  it('ALL 让各格子都算已授予；从角色得到的单独标出', () => {
    const all = directIndex([grant('ORDERS', 'ALL PRIVILEGES')])
    expect(hasAll(all, 'object', objectTarget('app', 'orders'))).toBeDefined()
    const eff: EffectivePrivilege[] = [{ grant: grant('CUSTOMERS', 'SELECT', 'r1'), via: ['r1'], state: 'allowed', notes: [] }]
    const inherited = inheritedIndex(eff, 'u')
    expect(cellState(k('CUSTOMERS', 'SELECT'), new Map(), undefined, inherited, new Map())).toBe('inherited')
  })

  it('角色加减也是改动；回收排在授予前面', () => {
    const role: Principal = { id: 'r1', name: 'R1', host: null, kind: 'role', level: 'server', can_login: null, locked: null, expires_at: null, builtin: false, attrs: [] }
    let p = toggleRole(new Map(), me, role, false)
    expect([...p.values()][0]).toMatchObject({ op: 'add_role' })
    p = toggleCell(p, k('ORDERS', 'SELECT'), me, 'object', objectTarget('APP', 'ORDERS'), 'SELECT', direct, false)
    expect(orderedChanges(p).map((c) => c.op)).toEqual(['revoke', 'add_role'])
    expect(toggleRole(p, me, role, false).size).toBe(1)
  })
})

describe('角色成员', () => {
  it('加成员、移出成员都是以当前角色为 role 的改动，再点一次撤销', () => {
    const role: PrincipalRef = { name: 'R', host: null, kind: 'role', level: 'server' }
    const user: Principal = { id: 'u2', name: 'U2', host: null, kind: 'user', level: 'server', can_login: true, locked: false, expires_at: null, builtin: false, attrs: [] }
    const add = toggleMember(new Map(), role, user, false)
    expect([...add.values()][0]).toMatchObject({ op: 'add_role', member: { name: 'U2' }, role: { name: 'R' } })
    expect(toggleMember(add, role, user, false).size).toBe(0)
    expect([...toggleMember(new Map(), role, user, true).values()][0]).toMatchObject({ op: 'remove_role' })
  })
})
