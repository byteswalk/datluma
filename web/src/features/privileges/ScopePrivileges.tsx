// 库与系统权限：全局（Oracle、达梦的系统权限，MySQL 的 *.*，SQL Server 的服务器权限）、库级（PG、SQL Server、GBase 8s）、
// 模式级（MySQL 的 db.*、PG 的 USAGE/CREATE、SQL Server 的架构）。常用的列成勾选框，清单外的可以手工添加。

import { AutoComplete, Button, Empty, Select } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import type { GrantScope, PrincipalRef, PrivCatalog, PrivilegeGrant } from '../../shared/api'
import { PrivCell } from './ObjectMatrix'
import { type Pending, type Target, cellKey, cellState, hasAll, scopeTarget, toggleCell } from './matrix'

const NO_SCHEMAS: { name: string; is_system: boolean }[] = []

function Section({ title, extra, children }: { title: string; extra?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <strong>{title}</strong>
        {extra}
      </div>
      {children}
    </div>
  )
}

/** 一级的勾选框：常用清单加上这一级已直接授予、但不在清单里的权限，再加一个手工添加框。 */
function ScopeGrid({ scope, target, list, grantee, direct, inherited, pending, onPending, write, pathOf }: {
  scope: GrantScope
  target: Target
  list: string[]
  grantee: PrincipalRef
  direct: Map<string, PrivilegeGrant>
  inherited: Map<string, string[]>
  pending: Pending
  onPending: (p: Pending) => void
  write: boolean
  pathOf: (via: string[]) => string
}) {
  const { t } = useTranslation()
  const [custom, setCustom] = useState('')
  const [extra, setExtra] = useState<string[]>([])
  const same = (g: PrivilegeGrant) =>
    g.scope === scope &&
    (g.target.database ?? '').toLowerCase() === (target.database ?? '').toLowerCase() &&
    (g.target.schema ?? '').toLowerCase() === (target.schema ?? '').toLowerCase()
  const items = useMemo(() => {
    const names = [...list]
    for (const g of direct.values()) if (same(g) && !names.some((n) => n.toUpperCase() === g.privilege.toUpperCase())) names.push(g.privilege)
    for (const e of extra) if (!names.some((n) => n.toUpperCase() === e.toUpperCase())) names.push(e)
    return names
  }, [list, direct, extra]) // eslint-disable-line react-hooks/exhaustive-deps
  const all = hasAll(direct, scope, target)
  const add = () => {
    const p = custom.trim().toUpperCase()
    if (!p) return
    setExtra((x) => [...x, p])
    setCustom('')
    const k = cellKey(scope, target, p)
    if (!direct.has(k) && !pending.has(k)) onPending(toggleCell(pending, k, grantee, scope, target, p, direct, false))
  }
  return (
    <>
      <div className="priv-grid">
        {items.map((p) => {
          const k = cellKey(scope, target, p)
          const via = inherited.get(k)
          return (
            <label key={p} className="priv-grid-item">
              <PrivCell state={cellState(k, direct, all, inherited, pending)} via={via ? pathOf(via) : undefined} disabled={!write} onToggle={() => onPending(toggleCell(pending, k, grantee, scope, target, p, direct, false))} />
              <span>{p}</span>
            </label>
          )
        })}
      </div>
      {write && (
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <AutoComplete size="small" style={{ width: 240 }} value={custom} onChange={setCustom} placeholder={t('privilege.scopeTab.custom')} />
          <Button size="small" disabled={!custom.trim()} onClick={add}>{t('privilege.scopeTab.add')}</Button>
        </div>
      )}
    </>
  )
}

export default function ScopePrivileges(props: {
  profileId: string
  catalog: string | undefined
  /** 连接配置里的库（PG 的库级授权用）。 */
  database: string | null
  privCatalog: PrivCatalog
  grantee: PrincipalRef
  direct: Map<string, PrivilegeGrant>
  inherited: Map<string, string[]>
  pending: Pending
  onPending: (p: Pending) => void
  write: boolean
  pathOf: (via: string[]) => string
}) {
  const { profileId, catalog, database, privCatalog } = props
  const api = useApi()
  const { t } = useTranslation()
  const { data: schemas = NO_SCHEMAS } = useQuery({
    queryKey: ['schemas', profileId, catalog],
    queryFn: () => api.schemas(profileId, undefined, catalog),
    enabled: privCatalog.schema.length > 0,
  })
  const userSchemas = useMemo(() => schemas.filter((s) => !s.is_system).map((s) => s.name), [schemas])
  const [schema, setSchema] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (schema === undefined && userSchemas.length) setSchema(userSchemas[0])
  }, [userSchemas, schema])
  // 库级授权的目标：SQL Server 是当前选的库，PG 是连接的库，GBase 8s 是当前库（不写库名）
  const dbName = catalog ?? database
  const grid = (scope: GrantScope, target: Target, list: string[]) => <ScopeGrid {...props} scope={scope} target={target} list={list} />
  const none = !privCatalog.global.length && !privCatalog.database.length && !privCatalog.schema.length
  if (none) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('privilege.scopeTab.none')} />
  return (
    <div style={{ paddingTop: 4 }}>
      {privCatalog.global.length > 0 && <Section title={t('privilege.scopeTab.global')}>{grid('global', scopeTarget('global', null), privCatalog.global)}</Section>}
      {privCatalog.database.length > 0 && (
        <Section title={t('privilege.scopeTab.database', { name: dbName ?? t('privilege.scopeTab.currentDb') })}>
          {grid('database', scopeTarget('database', dbName), privCatalog.database)}
        </Section>
      )}
      {privCatalog.schema.length > 0 && (
        <Section
          title={t('privilege.scopeTab.schema')}
          extra={<Select size="small" style={{ width: 200 }} showSearch value={schema} onChange={setSchema} options={userSchemas.map((s) => ({ value: s, label: s }))} />}
        >
          {schema !== undefined && <div key={schema}>{grid('schema', scopeTarget('schema', schema), privCatalog.schema)}</div>}
        </Section>
      )}
    </div>
  )
}
