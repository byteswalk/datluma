// 用户与权限标签（M9 设计文档第 8、9 节，第一期改版）：
// - 左侧主体列表按用户、角色分组，名字后面标出锁定、不可登录、已过期；
// - 右侧头部是名称和状态、改密 / 锁定 / 删除，以及"所属角色"标签（加减角色）；
// - 页签：对象权限（矩阵）、库与系统权限、实际权限、属性；
// - 勾选、加减角色都先攒成待提交的改动，底部一次预览、执行（BatchDialog）；改密、锁定、删除仍是单项确认（ChangeDialog）。
// 对象反查（从对象树"谁能访问"进来）时右侧列出访问者。

import { Alert, App, Button, Checkbox, Dropdown, Empty, Input, Select, Spin, Table, Tabs, Tag, Tooltip } from 'antd'
import type { ColumnsType } from 'antd/es/table'
import { IconArrowLeft, IconClockX, IconLock, IconPlus, IconRefresh, IconUserOff } from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import { schemaLabel, splitCatalog } from '../../shared/api'
import type { Coverage, EffectivePrivilege, Membership, Principal, PrivCaps, PrivCatalog, PrivChange, PrivNote } from '../../shared/api'
import { type QueryTab, useTabs } from '../editor/tabs'
import { BatchDialog } from './BatchDialog'
import NewUserDialog from './NewUserDialog'
import ObjectMatrix from './ObjectMatrix'
import { ChangeDialog, CreateDialog, PasswordDialog } from './PrivilegeDialogs'
import ScopePrivileges from './ScopePrivileges'
import { groupAccess, hasCredentials, pathLabel, principalRef, targetLabel } from './logic'
import { type Pending, directIndex, inheritedIndex, orderedChanges, roleKey, toggleRole } from './matrix'

type FormKind = 'new_user' | 'new_role' | 'password'

function CoverageNote({ coverage }: { coverage: Coverage | undefined }) {
  const { t } = useTranslation()
  if (coverage?.state !== 'partial') return null
  return <Alert type="warning" showIcon banner message={t('privilege.partial', { detail: coverage.missing.join(' · ') })} />
}

function Notes({ notes }: { notes: PrivNote[] }) {
  const { t } = useTranslation()
  if (!notes.length) return null
  return <span className="muted"> {notes.map((n) => t(`privilege.note.${n}`)).join(' · ')}</span>
}

function useEffectiveColumns(principals: Principal[]): ColumnsType<EffectivePrivilege> {
  const { t } = useTranslation()
  return [
    { title: t('privilege.col.target'), key: 'target', width: 220, ellipsis: true, render: (_, e) => targetLabel(e.grant) || t('privilege.scope.global') },
    { title: t('privilege.col.privilege'), key: 'privilege', width: 160, render: (_, e) => e.grant.privilege },
    { title: t('privilege.col.state'), dataIndex: 'state', width: 72, render: (s: EffectivePrivilege['state']) => t(`privilege.state.${s}`) },
    { title: t('privilege.col.path'), key: 'path', render: (_, e) => <span>{pathLabel(e.via, principals)}<Notes notes={e.notes} /></span> },
  ]
}

/** 名字后面的状态小图标：锁定、不可登录、已过期。 */
function StatusIcons({ p }: { p: Principal }) {
  const { t } = useTranslation()
  return (
    <>
      {p.locked && <Tooltip title={t('privilege.status.locked')}><IconLock size={13} className="muted" /></Tooltip>}
      {p.kind !== 'role' && p.can_login === false && <Tooltip title={t('privilege.status.noLogin')}><IconUserOff size={13} className="muted" /></Tooltip>}
      {p.expires_at && <Tooltip title={t('privilege.status.expires', { at: p.expires_at })}><IconClockX size={13} className="muted" /></Tooltip>}
    </>
  )
}

/** 属性值写成人能读的：true/false 变成是/否。 */
function humanValue(v: string, yes: string, no: string): string {
  const s = v.trim().toLowerCase()
  if (s === 'true' || s === 't' || s === 'y' || s === 'yes') return yes
  if (s === 'false' || s === 'f' || s === 'n' || s === 'no') return no
  return v
}

function PrincipalDetail({ tab, catalog, database, principal, principals, memberships, caps, privCatalog, pending, onPending, onForm, onChange }: {
  tab: QueryTab
  catalog: string | undefined
  database: string | null
  principal: Principal
  principals: Principal[]
  memberships: Membership[]
  caps: PrivCaps
  privCatalog: PrivCatalog
  pending: Pending
  onPending: (p: Pending) => void
  onForm: (f: FormKind) => void
  onChange: (c: PrivChange) => void
}) {
  const api = useApi()
  const { t } = useTranslation()
  const effectiveColumns = useEffectiveColumns(principals)
  const { data, error, isLoading } = useQuery({
    queryKey: ['privileges', tab.profileId, catalog, 'principal', principal.id],
    queryFn: () => api.principalPrivileges(tab.profileId, principal.id, catalog),
  })
  const ref = principalRef(principal)
  const direct = useMemo(() => directIndex(data?.direct ?? []), [data])
  const inherited = useMemo(() => inheritedIndex(data?.effective ?? [], principal.id), [data, principal.id])
  const pathOf = (via: string[]) => pathLabel(via, principals)
  const nameOf = (id: string) => principals.find((p) => p.id === id)?.name ?? id
  const memberOf = memberships.filter((m) => m.member === principal.id)
  const write = caps.write
  const yesNo = (v: boolean | null) => (v === null ? t('privilege.unknown') : v ? t('privilege.yes') : t('privilege.no'))

  // 所属角色：现有的（待移出的划掉），加上待加入的
  const roleOf = (id: string) => principals.find((p) => p.id === id)
  const pendingAdds = principals.filter((p) => pending.get(roleKey(p.id))?.op === 'add_role')
  const candidates = principals.filter(
    (p) => p.kind === 'role' && p.id !== principal.id && p.level === principal.level && !memberOf.some((m) => m.role === p.id) && !pending.has(roleKey(p.id)),
  )
  const setDefault = (m: Membership) => {
    const role = roleOf(m.role)
    if (role) onChange({ op: 'set_default_role', member: ref, role: m.default_role ? null : principalRef(role) })
  }

  const rows: [string, string][] = [
    [t('privilege.attr.kind'), t(`privilege.kindName.${principal.kind}`)],
    [t('privilege.attr.level'), t(`privilege.levelName.${principal.level}`)],
    ...(principal.host ? ([[t('privilege.attr.host'), principal.host]] as [string, string][]) : []),
    [t('privilege.attr.login'), yesNo(principal.can_login)],
    [t('privilege.attr.locked'), yesNo(principal.locked)],
    [t('privilege.attr.expires'), principal.expires_at ?? '—'],
    [t('privilege.attr.builtin'), principal.builtin ? t('privilege.yes') : t('privilege.no')],
    ...principal.attrs.map(([k, v]): [string, string] => [k, humanValue(v, t('privilege.yes'), t('privilege.no'))]),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <CoverageNote coverage={data?.coverage} />
      {error && <div className="err" style={{ padding: 12 }}>{t('privilege.error', { detail: (error as Error).message })}</div>}
      <div className="priv-head">
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <strong style={{ fontSize: 'var(--fs-lg, 15px)' }}>{principal.name}</strong>
          {principal.host && <span className="muted">@{principal.host}</span>}
          <span className="muted">{t(`privilege.kindName.${principal.kind}`)}</span>
          {principal.kind !== 'role' && principal.can_login !== null && <span className="muted">· {principal.can_login ? t('privilege.status.canLogin') : t('privilege.status.noLogin')}</span>}
          {principal.locked && <span className="muted">· {t('privilege.status.locked')}</span>}
          <span className="grow" />
          {write && (
            <div className="seg-actions">
              {hasCredentials(principal) && <Button size="small" type="text" onClick={() => onForm('password')}>{t('privilege.action.setPassword')}</Button>}
              {hasCredentials(principal) && caps.lock && (
                <Button size="small" type="text" onClick={() => onChange({ op: 'set_locked', principal: ref, locked: !principal.locked })}>
                  {t(principal.locked ? 'privilege.action.unlock' : 'privilege.action.lock')}
                </Button>
              )}
              <Button size="small" type="text" danger onClick={() => onChange({ op: 'drop', principal: ref })}>
                {t(caps.os_accounts && principal.kind === 'user' ? 'privilege.action.removeUser' : 'privilege.action.drop')}
              </Button>
            </div>
          )}
        </div>
        {caps.roles && (
          <div className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <span className="muted">{t('privilege.attr.roles')}：</span>
            {memberOf.length === 0 && pendingAdds.length === 0 && <span className="muted">—</span>}
            {memberOf.map((m) => {
              const role = roleOf(m.role)
              const removing = pending.has(roleKey(m.role))
              return (
                <Tag
                  key={m.role}
                  className={removing ? 'priv-tag-removing' : undefined}
                  closable={write && !!role}
                  onClose={(e) => {
                    e.preventDefault()
                    if (role) onPending(toggleRole(pending, ref, role, true))
                  }}
                >
                  {nameOf(m.role)}
                  {m.default_role && <span className="muted"> · {t('privilege.defaultRole')}</span>}
                </Tag>
              )
            })}
            {pendingAdds.map((r) => (
              <Tag key={r.id} className="priv-tag-adding" closable onClose={(e) => { e.preventDefault(); onPending(toggleRole(pending, ref, r, false)) }}>
                + {r.name}
              </Tag>
            ))}
            {write && candidates.length > 0 && (
              <Select
                size="small"
                showSearch
                value={null}
                placeholder={t('privilege.action.addRole')}
                style={{ width: 150 }}
                optionFilterProp="label"
                options={candidates.map((r) => ({ value: r.id, label: r.name }))}
                onChange={(id: string) => {
                  const role = roleOf(id)
                  if (role) onPending(toggleRole(pending, ref, role, false))
                }}
              />
            )}
          </div>
        )}
      </div>
      <Tabs
        size="small"
        className="priv-tabs"
        style={{ padding: '0 12px', flex: 1, minHeight: 0 }}
        items={[
          {
            key: 'objects',
            label: t('privilege.tab.objects'),
            children: isLoading ? <Spin style={{ margin: 32 }} /> : (
              <ObjectMatrix
                profileId={tab.profileId}
                catalog={catalog}
                grantee={ref}
                privileges={privCatalog.object}
                direct={direct}
                inherited={inherited}
                pending={pending}
                onPending={onPending}
                write={write}
                pathOf={pathOf}
              />
            ),
          },
          {
            key: 'scope',
            label: t('privilege.tab.scope'),
            children: isLoading ? <Spin style={{ margin: 32 }} /> : (
              <ScopePrivileges
                profileId={tab.profileId}
                catalog={catalog}
                database={database}
                privCatalog={privCatalog}
                grantee={ref}
                direct={direct}
                inherited={inherited}
                pending={pending}
                onPending={onPending}
                write={write}
                pathOf={pathOf}
              />
            ),
          },
          {
            key: 'effective',
            label: t('privilege.tab.effective'),
            children: (
              <>
                <div className="muted" style={{ marginBottom: 8 }}>{t('privilege.computed')}</div>
                <Table
                  size="small"
                  pagination={false}
                  loading={isLoading}
                  locale={{ emptyText: t('privilege.effectiveEmpty') }}
                  rowKey={(e) => `${e.via.join('>')}|${e.grant.scope}|${targetLabel(e.grant)}|${e.grant.privilege}`}
                  columns={effectiveColumns}
                  dataSource={data?.effective}
                />
              </>
            ),
          },
          {
            key: 'attrs',
            label: t('privilege.tab.attrs'),
            children: (
              <table className="kv">
                <tbody>
                  {rows.map(([k, v]) => (
                    <tr key={k}><td className="muted" style={{ paddingRight: 24 }}>{k}</td><td>{v}</td></tr>
                  ))}
                  {caps.os_accounts && memberOf.map((m) => (
                    <tr key={m.role}>
                      <td className="muted" style={{ paddingRight: 24 }}>{nameOf(m.role)}</td>
                      <td><a onClick={() => setDefault(m)}>{t(m.default_role ? 'privilege.action.clearDefault' : 'privilege.action.setDefault')}</a></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ),
          },
        ]}
      />
    </div>
  )
}

function ObjectAccessPanel({ tab, principals, onPick }: { tab: QueryTab; principals: Principal[]; onPick: (id: string) => void }) {
  const api = useApi()
  const { t } = useTranslation()
  const focus = tab.privileges!.focus!
  const { catalog, schema } = splitCatalog(focus.schema)
  const { data, error, isLoading } = useQuery({
    queryKey: ['privileges', tab.profileId, catalog, 'object', focus.schema, focus.object],
    queryFn: () => api.objectAccess(tab.profileId, schema, focus.object, catalog),
  })
  const groups = useMemo(() => groupAccess(data?.access ?? []), [data])
  return (
    <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <div className="row" style={{ padding: '6px 12px', gap: 8 }}>
        <Button size="small" type="text" icon={<IconArrowLeft size={14} />} onClick={() => useTabs.getState().setPrivilegesFocus(tab.id, undefined)}>
          {t('privilege.object.back')}
        </Button>
        <strong>{t('privilege.object.title', { target: `${schemaLabel(focus.schema)}.${focus.object}` })}</strong>
      </div>
      <CoverageNote coverage={data?.coverage} />
      <div className="muted" style={{ padding: '4px 12px' }}>{t('privilege.computed')}</div>
      {error && <div className="err" style={{ padding: 12 }}>{t('privilege.error', { detail: (error as Error).message })}</div>}
      <div style={{ flex: 1, overflow: 'auto', padding: '0 12px' }}>
        {isLoading ? <Spin style={{ margin: 48 }} /> : !groups.length ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('privilege.object.none')} />
        ) : (
          groups.map((g) => (
            <div key={g.principal} style={{ marginBottom: 12 }}>
              <a onClick={() => onPick(g.principal)}>{principals.find((p) => p.id === g.principal)?.name ?? g.principal}</a>
              {g.items.map((a, i) => (
                <div key={i} className="muted" style={{ paddingLeft: 12 }}>
                  {a.privilege.grant.privilege} · {t(`privilege.state.${a.privilege.state}`)} · {pathLabel(a.privilege.via, principals)}
                  <Notes notes={a.privilege.notes} />
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

/** 左侧列表的一组（用户或角色）。 */
function Group({ title, list, picked, onPick }: { title: string; list: Principal[]; picked: string | null; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(true)
  if (!list.length) return null
  return (
    <div>
      <div className="priv-group" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'} {title}</span>
        <span className="muted">{list.length}</span>
      </div>
      {open && list.map((p) => (
        <div key={p.id} className={`hist-item priv-item${p.id === picked ? ' picked' : ''}`} onClick={() => onPick(p.id)}>
          <span className="priv-item-name">{p.name}{p.host && <span className="muted">@{p.host}</span>}</span>
          <StatusIcons p={p} />
        </div>
      ))}
    </div>
  )
}

export default function PrivilegesView({ tab }: { tab: QueryTab }) {
  const api = useApi()
  const qc = useQueryClient()
  const { modal } = App.useApp()
  const { t } = useTranslation()
  const [text, setText] = useState('')
  const [builtin, setBuiltin] = useState(false)
  const [picked, setPicked] = useState<string | null>(null)
  const focus = tab.privileges?.focus
  const focusCatalog = focus ? splitCatalog(focus.schema).catalog : undefined
  const [chosenCatalog, setChosenCatalog] = useState<string | undefined>(undefined)
  const catalog = focusCatalog ?? chosenCatalog
  // 从“谁能访问”回到账号页时留在同一个数据库
  useEffect(() => {
    if (focusCatalog) setChosenCatalog(focusCatalog)
  }, [focusCatalog])
  const { data: catalogs = [] } = useQuery({ queryKey: ['catalogs', tab.profileId], queryFn: () => api.catalogs(tab.profileId) })
  const { data: profile } = useQuery({ queryKey: ['profile', tab.profileId], queryFn: () => api.profile(tab.profileId) })
  const { data, error, isLoading } = useQuery({
    queryKey: ['privileges', tab.profileId, catalog, 'overview'],
    queryFn: () => api.privilegeOverview(tab.profileId, catalog),
  })
  const principals = useMemo(() => data?.principals ?? [], [data])
  const shown = useMemo(() => {
    const q = text.trim().toLowerCase()
    return principals.filter((p) => (builtin || !p.builtin) && (!q || p.name.toLowerCase().includes(q) || (p.host ?? '').toLowerCase().includes(q)))
  }, [principals, text, builtin])
  const current = principals.find((p) => p.id === picked)
  const [form, setForm] = useState<FormKind | null>(null)
  const [change, setChange] = useState<PrivChange | null>(null)
  const [pending, setPending] = useState<Pending>(new Map())
  const [reviewing, setReviewing] = useState(false)

  // 换主体前确认丢掉没提交的改动
  const pick = (id: string) => {
    if (id === picked) return
    const go = () => {
      setPending(new Map())
      setPicked(id)
      useTabs.getState().setPrivilegesFocus(tab.id, undefined)
    }
    if (pending.size) modal.confirm({ title: t('privilege.pending.discardTitle'), content: t('privilege.pending.discard', { n: pending.size }), onOk: go })
    else go()
  }
  // 从对象树点某个用户、角色进来：选中它，然后清掉这个请求
  const wanted = tab.privileges?.principal
  useEffect(() => {
    if (!wanted || !principals.length) return
    setPending(new Map())
    setPicked(wanted)
    useTabs.getState().setPrivilegesFocus(tab.id, undefined)
  }, [wanted, principals, tab.id])

  const refresh = () => void qc.invalidateQueries({ queryKey: ['privileges', tab.profileId] })
  // 新建用户后，列表刷新出来就选中它
  const [pickName, setPickName] = useState<string | null>(null)
  useEffect(() => {
    if (!pickName) return
    const p = principals.find((x) => x.name.toLowerCase() === pickName.toLowerCase() && x.kind !== 'role')
    if (!p) return
    setPickName(null)
    setPending(new Map())
    setPicked(p.id)
  }, [pickName, principals])
  const review = (c: PrivChange) => {
    setForm(null)
    setChange(c)
  }
  const users = shown.filter((p) => p.kind !== 'role')
  const roles = shown.filter((p) => p.kind === 'role')
  const changes = useMemo(() => orderedChanges(pending), [pending])

  return (
    <div style={{ display: 'flex', flex: 1, minHeight: 0, height: '100%' }}>
      <div style={{ width: 240, display: 'flex', flexDirection: 'column', borderRight: '1px solid var(--border)' }}>
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
          {catalogs.length > 0 && (
            <Select size="small" placeholder={t('privilege.catalog')} value={catalog} onChange={setChosenCatalog} showSearch optionFilterProp="label" options={catalogs.map((c) => ({ value: c.name, label: c.name }))} />
          )}
          <div className="row" style={{ gap: 4 }}>
            <Input size="small" allowClear placeholder={t('privilege.search')} value={text} onChange={(e) => setText(e.target.value)} />
            {data?.caps.write && (
              <Dropdown
                trigger={['click']}
                menu={{
                  items: [
                    { key: 'new_user', label: t('privilege.action.newUser') },
                    ...(data.caps.roles ? [{ key: 'new_role', label: t('privilege.action.newRole') }] : []),
                  ],
                  onClick: ({ key }) => setForm(key as FormKind),
                }}
              >
                <Button size="small" type="text" aria-label={t('privilege.action.new')} icon={<IconPlus size={14} />} />
              </Dropdown>
            )}
            <Tooltip title={t('privilege.refresh')}>
              <Button size="small" type="text" icon={<IconRefresh size={14} />} onClick={refresh} />
            </Tooltip>
          </div>
          <Checkbox checked={builtin} onChange={(e) => setBuiltin(e.target.checked)}>{t('privilege.showBuiltin')}</Checkbox>
        </div>
        <div style={{ flex: 1, overflow: 'auto' }}>
          {isLoading && <Spin style={{ margin: 24 }} />}
          {!isLoading && !shown.length && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('privilege.none')} />}
          <Group title={t('privilege.kind.user')} list={users} picked={picked} onPick={pick} />
          <Group title={t('privilege.kind.role')} list={roles} picked={picked} onPick={pick} />
        </div>
      </div>
      <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <CoverageNote coverage={data?.coverage} />
        {error && <div className="err" style={{ padding: 12 }}>{t('privilege.error', { detail: (error as Error).message })}</div>}
        {focus ? (
          <ObjectAccessPanel tab={tab} principals={principals} onPick={pick} />
        ) : current && data ? (
          <PrincipalDetail
            key={current.id}
            tab={tab}
            catalog={catalog}
            database={profile?.database ?? null}
            principal={current}
            principals={principals}
            memberships={data.memberships}
            caps={data.caps}
            privCatalog={data.catalog}
            pending={pending}
            onPending={setPending}
            onForm={setForm}
            onChange={setChange}
          />
        ) : (
          <Empty style={{ marginTop: 64 }} image={Empty.PRESENTED_IMAGE_SIMPLE} description={t('privilege.empty')} />
        )}
        {pending.size > 0 && (
          <div className="priv-pending">
            <span>{t('privilege.pending.count', { n: pending.size })}</span>
            <span className="grow" />
            <Button size="small" onClick={() => setPending(new Map())}>{t('privilege.pending.undo')}</Button>
            <Button size="small" type="primary" onClick={() => setReviewing(true)}>{t('privilege.pending.apply')}</Button>
          </div>
        )}
      </div>
      {data && form === 'new_user' && (
        <NewUserDialog
          profileId={tab.profileId}
          catalog={catalog}
          caps={data.caps}
          privCatalog={data.catalog}
          principals={principals}
          onClose={() => setForm(null)}
          onDone={(name) => {
            setPickName(name)
            refresh()
          }}
        />
      )}
      {data && form === 'new_role' && <CreateDialog role caps={data.caps} onCancel={() => setForm(null)} onNext={review} />}
      {current && form === 'password' && <PasswordDialog principal={current} onCancel={() => setForm(null)} onNext={review} />}
      {change && (
        <ChangeDialog
          profileId={tab.profileId}
          catalog={catalog}
          change={change}
          cascadable={change.op === 'drop' && (data?.caps.drop_cascade ?? false) && change.principal.kind !== 'role'}
          onClose={() => setChange(null)}
          onDone={refresh}
        />
      )}
      {reviewing && (
        <BatchDialog
          profileId={tab.profileId}
          catalog={catalog}
          changes={changes}
          onClose={() => setReviewing(false)}
          onDone={() => {
            setPending(new Map())
            refresh()
          }}
        />
      )}
    </div>
  )
}
