// 对象权限矩阵：选一个模式，每行一个表或视图，每列一种权限，直接勾选。勾选先攒成待提交的改动（见 matrix.ts）。
// 格子：勾上 = 直接授予；◐ = 从角色或 PUBLIC 得到（悬停看来源，这里不能去掉）；绿底 = 待授予，红底 = 待回收。

import { Checkbox, Empty, Input, Select, Spin, Table, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { IconEye, IconTable } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import { joinCatalog } from '../../shared/api'
import type { GrantScope, PrincipalRef, PrivilegeGrant } from '../../shared/api'
import { type CellState, type Pending, type Target, cellKey, cellState, hasAll, objectTarget, toggleCell, toggleMany } from './matrix'

/** 一个格子：勾选框，加上"来自角色"的标记和待提交改动的底色。 */
export function PrivCell({ state, via, disabled, onToggle }: {
  state: CellState
  via?: string
  disabled: boolean
  onToggle: () => void
}) {
  const { t } = useTranslation()
  const checked = state === 'direct' || state === 'all' || state === 'adding'
  const box = (
    <span className={`priv-cell priv-${state}`}>
      <Checkbox checked={checked} disabled={disabled || state === 'all'} onChange={onToggle} />
      {state === 'inherited' && <span className="priv-via">◐</span>}
    </span>
  )
  const tip = state === 'inherited' ? t('privilege.matrix.via', { path: via }) : state === 'all' ? t('privilege.matrix.viaAll') : null
  return tip ? <Tooltip title={tip}>{box}</Tooltip> : box
}

const NO_SCHEMAS: { name: string; is_system: boolean }[] = []
const NO_ROWS: Row[] = []

interface Row {
  name: string
  view: boolean
}

export default function ObjectMatrix({ profileId, catalog, grantee, privileges, direct, inherited, pending, onPending, write, pathOf }: {
  profileId: string
  catalog: string | undefined
  grantee: PrincipalRef
  /** 列：这个库表上常用的权限。 */
  privileges: string[]
  direct: Map<string, PrivilegeGrant>
  inherited: Map<string, string[]>
  pending: Pending
  onPending: (p: Pending) => void
  write: boolean
  pathOf: (via: string[]) => string
}) {
  const api = useApi()
  const { t } = useTranslation()
  const { data: schemas = NO_SCHEMAS } = useQuery({
    queryKey: ['schemas', profileId, catalog],
    queryFn: () => api.schemas(profileId, undefined, catalog),
  })
  const userSchemas = useMemo(() => schemas.filter((s) => !s.is_system).map((s) => s.name), [schemas])
  // 默认选有直接授权的第一个模式，否则第一个模式
  const granted = useMemo(() => [...direct.values()].filter((g) => g.scope === 'object').map((g) => g.target.schema), [direct])
  const [schema, setSchema] = useState<string | undefined>(undefined)
  useEffect(() => {
    if (schema !== undefined || !userSchemas.length) return
    setSchema(userSchemas.find((s) => granted.some((g) => g?.toLowerCase() === s.toLowerCase())) ?? userSchemas[0])
  }, [userSchemas, granted, schema])
  const key = schema === undefined ? undefined : catalog === undefined ? schema : joinCatalog(catalog, schema)
  const { data: rows = NO_ROWS, isLoading } = useQuery({
    queryKey: ['privileges', profileId, 'matrix-objects', key],
    enabled: key !== undefined,
    queryFn: async (): Promise<Row[]> => {
      const [tables, views] = await Promise.all([api.objects(profileId, key!, 'tables'), api.objects(profileId, key!, 'views').catch(() => [])])
      return [...tables.map((o) => ({ name: o.name, view: false })), ...views.map((o) => ({ name: o.name, view: true }))]
    },
  })
  const [text, setText] = useState('')
  const [onlyGranted, setOnlyGranted] = useState(false)
  const [withGrant, setWithGrant] = useState(false)

  const cell = (name: string, privilege: string) => {
    const target: Target = objectTarget(schema ?? '', name)
    const k = cellKey('object', target, privilege)
    return { key: k, scope: 'object' as GrantScope, target, privilege }
  }
  const stateOf = (name: string, privilege: string) => {
    const c = cell(name, privilege)
    return cellState(c.key, direct, hasAll(direct, 'object', c.target), inherited, pending)
  }
  const visible = rows.filter((r) => {
    if (text && !r.name.toLowerCase().includes(text.trim().toLowerCase())) return false
    return !onlyGranted || privileges.some((p) => stateOf(r.name, p) !== 'none')
  })
  const toggleRow = (name: string) => onPending(toggleMany(pending, privileges.map((p) => cell(name, p)), grantee, direct, withGrant))
  const toggleColumn = (privilege: string) => onPending(toggleMany(pending, visible.map((r) => cell(r.name, privilege)), grantee, direct, withGrant))

  const columns: ColumnsType<Row> = [
    {
      title: t('privilege.matrix.object'),
      key: 'name',
      fixed: 'left',
      width: 220,
      ellipsis: true,
      render: (_, r) => (
        <span className="row" style={{ gap: 6 }}>
          {r.view ? <IconEye size={14} className="ic-view" /> : <IconTable size={14} className="ic-table" />}
          {r.name}
        </span>
      ),
    },
    ...privileges.map((p) => ({
      title: write ? <a onClick={() => toggleColumn(p)} title={t('privilege.matrix.toggleColumn')}>{p}</a> : p,
      key: p,
      width: Math.max(72, p.length * 9 + 24),
      align: 'center' as const,
      render: (_: unknown, r: Row) => {
        const c = cell(r.name, p)
        const via = inherited.get(c.key)
        return <PrivCell state={stateOf(r.name, p)} via={via ? pathOf(via) : undefined} disabled={!write} onToggle={() => onPending(toggleCell(pending, c.key, grantee, 'object', c.target, p, direct, withGrant))} />
      },
    })),
    ...(write ? [{ title: '', key: 'all', width: 64, render: (_: unknown, r: Row) => <a onClick={() => toggleRow(r.name)}>{t('privilege.matrix.all')}</a> }] : []),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="row" style={{ gap: 8, padding: '4px 0 8px', flexWrap: 'wrap' }}>
        <Select size="small" style={{ width: 200 }} showSearch value={schema} placeholder={t('privilege.matrix.schema')} onChange={setSchema} options={userSchemas.map((s) => ({ value: s, label: s }))} />
        <Input size="small" allowClear style={{ width: 180 }} placeholder={t('privilege.matrix.search')} value={text} onChange={(e) => setText(e.target.value)} />
        <Checkbox checked={onlyGranted} onChange={(e) => setOnlyGranted(e.target.checked)}>{t('privilege.matrix.onlyGranted')}</Checkbox>
        {write && <Checkbox checked={withGrant} onChange={(e) => setWithGrant(e.target.checked)}>{t('privilege.matrix.withGrant')}</Checkbox>}
      </div>
      {isLoading ? (
        <Spin style={{ margin: 32 }} />
      ) : !visible.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t(rows.length ? 'privilege.matrix.noMatch' : 'privilege.matrix.noObjects')} />
      ) : (
        <Table size="small" pagination={false} rowKey="name" columns={columns} dataSource={visible} scroll={{ x: 'max-content' }} sticky />
      )}
    </div>
  )
}
