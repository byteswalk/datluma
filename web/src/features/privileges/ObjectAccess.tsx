// 从对象出发授权（对象树的"谁能访问""授权给…"）：一个表或视图，每行一个用户或角色，每列一种权限，直接勾选。
// 勾上 = 直接授予这个主体；◐ = 它通过角色、PUBLIC、模式级或全局权限得到（悬停看来源，这里不能去掉）。
// 改动先攒着，底部一次预览、执行（BatchDialog），和按主体编辑的矩阵一样。

import { Alert, Button, Empty, Select, Spin, Table } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { IconArrowLeft } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import { schemaLabel, splitCatalog } from '../../shared/api'
import type { Coverage, ObjectAccess, Principal, PrivCaps, PrivCatalog, PrivilegeGrant } from '../../shared/api'
import { type QueryTab, useTabs } from '../editor/tabs'
import { BatchDialog } from './BatchDialog'
import { PrivCell } from './ObjectMatrix'
import { pathLabel, principalRef } from './logic'
import { type CellState, type Pending, objectTarget, orderedChanges, principalCellKey } from './matrix'

const NO_ACCESS: ObjectAccess[] = []

interface Row {
  principal: Principal
  /** 直接授予这个主体的对象权限：权限名（大写）→ 授权记录（回收时要用）。 */
  direct: Map<string, PrivilegeGrant>
  /** 从别处得到的：权限名 → 来源路径。 */
  inherited: Map<string, string[]>
}

function buildRows(access: ObjectAccess[], principals: Principal[], extra: string[]): Row[] {
  const rows = new Map<string, Row>()
  const ensure = (id: string) => {
    let r = rows.get(id)
    if (!r) {
      const principal = principals.find((p) => p.id === id)
      if (!principal) return undefined
      r = { principal, direct: new Map(), inherited: new Map() }
      rows.set(id, r)
    }
    return r
  }
  for (const a of access) {
    const r = ensure(a.principal)
    if (!r || a.privilege.state !== 'allowed') continue
    const g = a.privilege.grant
    const name = g.privilege.trim().toUpperCase()
    if (g.grantee === a.principal && g.scope === 'object' && g.effect === 'grant') r.direct.set(name, g)
    else if (!r.inherited.has(name)) r.inherited.set(name, a.privilege.via.length ? a.privilege.via : [g.grantee])
  }
  for (const id of extra) ensure(id)
  return [...rows.values()]
}

export default function ObjectAccessMatrix({ tab, principals, caps, privCatalog, coverage, onPick }: {
  tab: QueryTab
  principals: Principal[]
  caps: PrivCaps
  privCatalog: PrivCatalog
  coverage: Coverage | undefined
  onPick: (id: string) => void
}) {
  const api = useApi()
  const qc = useQueryClient()
  const { t } = useTranslation()
  const focus = tab.privileges!.focus!
  const { catalog, schema } = splitCatalog(focus.schema)
  const { data, error, isLoading } = useQuery({
    queryKey: ['privileges', tab.profileId, catalog, 'object', focus.schema, focus.object],
    queryFn: () => api.objectAccess(tab.profileId, schema, focus.object, catalog),
  })
  const access = data?.access ?? NO_ACCESS
  const [extra, setExtra] = useState<string[]>([])
  const rows = useMemo(() => buildRows(access, principals, extra), [access, principals, extra])
  const [pending, setPending] = useState<Pending>(new Map())
  const [reviewing, setReviewing] = useState(false)
  const write = caps.write
  const target = objectTarget(schema, focus.object)
  // 列：常用的表权限，再加上已经出现过的其他权限
  const privileges = useMemo(() => {
    const list = [...privCatalog.object]
    for (const r of rows) for (const p of [...r.direct.keys(), ...r.inherited.keys()]) if (!list.some((x) => x.toUpperCase() === p)) list.push(p)
    return list
  }, [privCatalog, rows])

  const stateOf = (r: Row, privilege: string): CellState => {
    const p = privilege.toUpperCase()
    if (pending.has(principalCellKey(r.principal.id, p))) return r.direct.has(p) ? 'removing' : 'adding'
    if (r.direct.has(p)) return 'direct'
    if (r.direct.has('ALL') || r.direct.has('ALL PRIVILEGES')) return 'all'
    if (r.inherited.has(p)) return 'inherited'
    return 'none'
  }
  const toggle = (next: Pending, r: Row, privilege: string): Pending => {
    const p = privilege.toUpperCase()
    const key = principalCellKey(r.principal.id, p)
    const out = new Map(next)
    if (out.has(key)) {
      out.delete(key)
      return out
    }
    const grantee = principalRef(r.principal)
    const g = r.direct.get(p)
    out.set(
      key,
      g
        ? { op: 'revoke', grantee, scope: 'object', target: g.target, privilege: g.privilege, grantable: g.grantable, grantor: g.grantor }
        : { op: 'grant', grantee, scope: 'object', target, privilege, with_grant: false },
    )
    return out
  }
  const on = (r: Row, p: string) => ['direct', 'adding'].includes(stateOf(r, p))
  const toggleSet = (cells: [Row, string][]) => {
    const turnOn = cells.some(([r, p]) => !on(r, p) && stateOf(r, p) !== 'all')
    let next = pending
    for (const [r, p] of cells) if (stateOf(r, p) !== 'all' && on(r, p) !== turnOn) next = toggle(next, r, p)
    setPending(next)
  }

  const columns: ColumnsType<Row> = [
    {
      title: t('privilege.col.principal'),
      key: 'principal',
      fixed: 'left',
      width: 200,
      ellipsis: true,
      render: (_, r) => (
        <span>
          <a onClick={() => onPick(r.principal.id)}>{r.principal.name}</a>
          {r.principal.host && <span className="muted">@{r.principal.host}</span>}
          <span className="muted" style={{ marginLeft: 6 }}>{t(`privilege.kindName.${r.principal.kind}`)}</span>
        </span>
      ),
    },
    ...privileges.map((p) => ({
      title: write ? <a onClick={() => toggleSet(rows.map((r) => [r, p] as [Row, string]))}>{p}</a> : p,
      key: p,
      width: Math.max(72, p.length * 9 + 24),
      align: 'center' as const,
      render: (_: unknown, r: Row) => {
        const via = r.inherited.get(p.toUpperCase())
        return <PrivCell state={stateOf(r, p)} via={via ? pathLabel(via, principals) : undefined} disabled={!write} onToggle={() => setPending(toggle(pending, r, p))} />
      },
    })),
    ...(write ? [{ title: '', key: 'all', width: 64, render: (_: unknown, r: Row) => <a onClick={() => toggleSet(privileges.map((p) => [r, p] as [Row, string]))}>{t('privilege.matrix.all')}</a> }] : []),
  ]
  const candidates = principals.filter((p) => !p.builtin && !rows.some((r) => r.principal.id === p.id))
  const back = () => useTabs.getState().setPrivilegesFocus(tab.id, undefined)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="row" style={{ padding: '6px 12px', gap: 8 }}>
        <Button size="small" type="text" icon={<IconArrowLeft size={14} />} onClick={back}>{t('privilege.object.back')}</Button>
        <strong>{t('privilege.object.title', { target: `${schemaLabel(focus.schema)}.${focus.object}` })}</strong>
      </div>
      {(coverage?.state === 'partial' || data?.coverage.state === 'partial') && (
        <Alert type="warning" showIcon banner message={t('privilege.partial', { detail: [...(data?.coverage.state === 'partial' ? data.coverage.missing : [])].join(' · ') })} />
      )}
      {error && <div className="err" style={{ padding: 12 }}>{t('privilege.error', { detail: (error as Error).message })}</div>}
      <div className="row" style={{ padding: '0 12px 8px', gap: 8 }}>
        {write && candidates.length > 0 && (
          <Select
            size="small"
            showSearch
            value={null}
            placeholder={t('privilege.object.addPrincipal')}
            style={{ width: 220 }}
            optionFilterProp="label"
            options={candidates.map((p) => ({ value: p.id, label: p.host ? `${p.name}@${p.host}` : p.name }))}
            onChange={(id: string) => setExtra((x) => [...x, id])}
          />
        )}
        <span className="muted">{t('privilege.computed')}</span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '0 12px' }}>
        {isLoading ? (
          <Spin style={{ margin: 48 }} />
        ) : !rows.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('privilege.object.none')} />
        ) : (
          <Table size="small" pagination={false} rowKey={(r) => r.principal.id} columns={columns} dataSource={rows} scroll={{ x: 'max-content' }} sticky />
        )}
      </div>
      {pending.size > 0 && (
        <div className="priv-pending">
          <span>{t('privilege.pending.count', { n: pending.size })}</span>
          <span className="grow" />
          <Button size="small" onClick={() => setPending(new Map())}>{t('privilege.pending.undo')}</Button>
          <Button size="small" type="primary" onClick={() => setReviewing(true)}>{t('privilege.pending.apply')}</Button>
        </div>
      )}
      {reviewing && (
        <BatchDialog
          profileId={tab.profileId}
          catalog={catalog}
          changes={orderedChanges(pending)}
          onClose={() => setReviewing(false)}
          onDone={() => {
            setPending(new Map())
            void qc.invalidateQueries({ queryKey: ['privileges', tab.profileId] })
          }}
        />
      )}
    </div>
  )
}
