// 权限矩阵和待提交改动的纯逻辑：界面上勾选、加减角色都先攒成改动，最后一起预览、执行（和数据编辑一样）。
// 一个"格子"是 (范围, 目标, 权限)：对象权限的目标是 模式.对象，模式级是模式，库级是库，全局为空。

import type { EffectivePrivilege, GrantScope, Principal, PrincipalRef, PrivChange, PrivilegeGrant } from '../../shared/api'

export type Target = PrivilegeGrant['target']

/** 格子的键：名字不分大小写（各库未加引号的名字大小写规则不同，比较时统一小写）。 */
export function cellKey(scope: GrantScope, target: Target, privilege: string): string {
  const part = (v: string | null) => (v ?? '').toLowerCase()
  return [scope, part(target.database), part(target.schema), part(target.object), part(target.column), privilege.trim().toUpperCase()].join('\u0001')
}

export function objectTarget(schema: string, object: string): Target {
  return { database: null, schema, object_kind: 'table', object, column: null }
}

export function scopeTarget(scope: GrantScope, name: string | null): Target {
  return {
    database: scope === 'database' ? name : null,
    schema: scope === 'schema' ? name : null,
    object_kind: null,
    object: null,
    column: null,
  }
}

/** 直接授给这个主体的权限，按格子索引（显式授予的；ALL 另外记）。 */
export function directIndex(direct: PrivilegeGrant[]): Map<string, PrivilegeGrant> {
  const m = new Map<string, PrivilegeGrant>()
  for (const g of direct) {
    if (g.effect !== 'grant') continue
    m.set(cellKey(g.scope, g.target, g.privilege), g)
  }
  return m
}

/** 这个目标上有没有直接授予的 ALL（ALL PRIVILEGES）：有的话各格子都算已授予，单个格子不能单独去掉。 */
export function hasAll(direct: Map<string, PrivilegeGrant>, scope: GrantScope, target: Target): PrivilegeGrant | undefined {
  return direct.get(cellKey(scope, target, 'ALL')) ?? direct.get(cellKey(scope, target, 'ALL PRIVILEGES'))
}

/** 从别处（角色、PUBLIC）得到的权限：格子 → 来源路径（主体 id 列表）。只算允许的。 */
export function inheritedIndex(effective: EffectivePrivilege[], principalId: string): Map<string, string[]> {
  const m = new Map<string, string[]>()
  for (const e of effective) {
    if (e.state !== 'allowed' || e.grant.grantee === principalId) continue
    const key = cellKey(e.grant.scope, e.grant.target, e.grant.privilege)
    if (!m.has(key)) m.set(key, e.via.length ? e.via : [e.grant.grantee])
  }
  return m
}

/** 待提交的改动：键 → 改动。同一个格子再点一次就是撤销这次改动。 */
export type Pending = Map<string, PrivChange>

export type CellState = 'none' | 'direct' | 'all' | 'inherited' | 'adding' | 'removing'

export function cellState(
  key: string,
  direct: Map<string, PrivilegeGrant>,
  all: PrivilegeGrant | undefined,
  inherited: Map<string, string[]>,
  pending: Pending,
): CellState {
  if (pending.has(key)) return direct.has(key) ? 'removing' : 'adding'
  if (direct.has(key)) return 'direct'
  if (all) return 'all'
  if (inherited.has(key)) return 'inherited'
  return 'none'
}

/** 点一个格子：已有改动就撤销；已直接授予就回收；否则授予。返回新的改动表（不改原表）。 */
export function toggleCell(
  pending: Pending,
  key: string,
  grantee: PrincipalRef,
  scope: GrantScope,
  target: Target,
  privilege: string,
  direct: Map<string, PrivilegeGrant>,
  withGrant: boolean,
): Pending {
  const next = new Map(pending)
  if (next.has(key)) {
    next.delete(key)
    return next
  }
  const g = direct.get(key)
  next.set(
    key,
    g
      ? { op: 'revoke', grantee, scope, target: g.target, privilege: g.privilege, grantable: g.grantable, grantor: g.grantor }
      : { op: 'grant', grantee, scope, target, privilege, with_grant: withGrant },
  )
  return next
}

/** 一组格子一起点（整行、整列全选）：只要有没勾上的就全部勾上，否则全部去掉。 */
export function toggleMany(
  pending: Pending,
  cells: { key: string; scope: GrantScope; target: Target; privilege: string }[],
  grantee: PrincipalRef,
  direct: Map<string, PrivilegeGrant>,
  withGrant: boolean,
): Pending {
  const on = (key: string) => (pending.has(key) ? !direct.has(key) : direct.has(key))
  const turnOn = cells.some((c) => !on(c.key))
  let next = pending
  for (const c of cells) {
    if (on(c.key) !== turnOn) next = toggleCell(next, c.key, grantee, c.scope, c.target, c.privilege, direct, withGrant)
  }
  return next
}

export function roleKey(role: string): string {
  return `role\u0001${role}`
}

/** 加入、移出角色也作为改动攒着；已经是成员的再"加入"就是撤销移出。 */
export function toggleRole(pending: Pending, member: PrincipalRef, role: Principal, isMember: boolean): Pending {
  const next = new Map(pending)
  const key = roleKey(role.id)
  if (next.has(key)) next.delete(key)
  else {
    const ref: PrincipalRef = { name: role.name, host: role.host, kind: role.kind, level: role.level }
    next.set(key, isMember ? { op: 'remove_role', member, role: ref } : { op: 'add_role', member, role: ref })
  }
  return next
}

/** 回收先于授予：同一批里先去掉再加上，避免有的库报"已存在"之类的冲突。 */
export function orderedChanges(pending: Pending): PrivChange[] {
  const rank = (c: PrivChange) => (c.op === 'revoke' || c.op === 'remove_role' ? 0 : 1)
  return [...pending.values()].sort((a, b) => rank(a) - rank(b))
}
