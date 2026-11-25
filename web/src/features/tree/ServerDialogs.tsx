// 对象树上的新建 / 删除库、模式，以及从"服务器对象"新建、删除用户和角色。
// 库和模式：先填表（删除时跳过），再看后端生成的语句和提示，确认后执行；生产连接上删除要输入名称。
// 用户和角色复用账号权限里的对话框（预览、密码不落地、生产确认都在那里）。

import { AutoComplete, Button, Input, Modal, Spin } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import type { NamespaceCaps, NamespaceChange, NamespacePreview, PrivChange } from '../../shared/api'
import { ChangeDialog, CreateDialog } from '../privileges/PrivilegeDialogs'
import { principalRef } from '../privileges/logic'
import NewUserDialog from '../privileges/NewUserDialog'
import { COMMON_CHARSETS } from './serverObjects'

const SQL_STYLE = { whiteSpace: 'pre-wrap', margin: '0 0 8px', fontFamily: 'var(--mono)' } as const

/** 新建（`create` 给出建库还是建模式）或删除（`drop` 给出要执行的操作）。 */
export function NamespaceDialog({ profileId, catalog, caps, create, drop, onClose, onDone }: {
  profileId: string
  /** SQL Server 在哪个库里建、删架构。 */
  catalog?: string
  caps: NamespaceCaps
  create?: 'database' | 'schema'
  drop?: NamespaceChange
  onClose: () => void
  onDone: (change: NamespaceChange) => void
}) {
  const api = useApi()
  const { t } = useTranslation()
  const [name, setName] = useState('')
  const [charset, setCharset] = useState(caps.charset ? 'utf8mb4' : '')
  const [collation, setCollation] = useState('')
  const [owner, setOwner] = useState('')
  const [change, setChange] = useState<NamespaceChange | null>(drop ?? null)
  const [preview, setPreview] = useState<NamespacePreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState(false)
  // 所有者从库里的用户、角色里选（也可以直接输入）
  const { data: overview } = useQuery({
    queryKey: ['privileges', profileId, catalog, 'overview'],
    queryFn: () => api.privilegeOverview(profileId, catalog),
    enabled: create === 'schema' && caps.owner,
  })
  const owners = (overview?.principals ?? []).filter((p) => !p.builtin || p.kind === 'user').map((p) => p.name)

  useEffect(() => {
    if (!change) return
    let live = true
    setPreview(null)
    setError(null)
    api.namespacePreview(profileId, change, catalog).then(
      (p) => live && setPreview(p),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [api, profileId, catalog, change])

  const kindWord = t(create === 'database' || change?.op === 'create_database' || change?.op === 'drop_database' ? 'tree.ns.database' : 'tree.ns.schema')
  const isDrop = change?.op === 'drop_database' || change?.op === 'drop_schema'

  if (!change) {
    const next = () =>
      setChange(
        create === 'database'
          ? { op: 'create_database', name: name.trim(), charset: caps.charset ? charset.trim() || null : null, collation: caps.charset ? collation.trim() || null : null }
          : { op: 'create_schema', name: name.trim(), owner: caps.owner ? owner.trim() || null : null },
      )
    const ownerMissing = create === 'schema' && caps.owner_required && !owner.trim()
    return (
      <Modal open title={t('tree.ns.createTitle', { kind: kindWord })} onCancel={onClose} destroyOnHidden okText={t('tree.ns.next')} cancelText={t('tree.ns.cancel')} okButtonProps={{ disabled: !name.trim() || ownerMissing }} onOk={next}>
        <Field label={t('tree.ns.name')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} onPressEnter={() => name.trim() && !ownerMissing && next()} />
        </Field>
        {create === 'database' && caps.charset && (
          <>
            <Field label={t('tree.ns.charset')}>
              <AutoComplete value={charset} onChange={setCharset} options={COMMON_CHARSETS.map((c) => ({ value: c }))} style={{ width: '100%' }} />
            </Field>
            <Field label={t('tree.ns.collation')}>
              <Input value={collation} placeholder={t('tree.ns.collationDefault')} onChange={(e) => setCollation(e.target.value)} />
            </Field>
          </>
        )}
        {create === 'schema' && caps.owner && (
          <Field label={caps.owner_required ? t('tree.ns.owner') : t('tree.ns.ownerOptional')}>
            <AutoComplete
              value={owner}
              onChange={setOwner}
              options={owners.filter((o) => o.toLowerCase().includes(owner.toLowerCase())).map((o) => ({ value: o }))}
              placeholder={caps.owner_required ? undefined : t('tree.ns.ownerDefault')}
              style={{ width: '100%' }}
            />
          </Field>
        )}
      </Modal>
    )
  }

  const blocked = !preview || running || (preview.confirm_name !== null && typed !== preview.confirm_name)
  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      await api.namespaceApply(profileId, change, catalog, preview?.confirm_name ? typed : undefined)
      onDone(change)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }
  const title = isDrop ? t('tree.ns.dropTitle', { kind: kindWord, name: change.name }) : t('tree.ns.createTitle', { kind: kindWord })
  return (
    <Modal
      open
      title={title}
      onCancel={onClose}
      destroyOnHidden
      footer={[
        !isDrop && !drop && (
          <Button key="back" onClick={() => { setChange(null); setPreview(null) }}>
            {t('tree.ns.back')}
          </Button>
        ),
        <Button key="cancel" onClick={onClose}>{t('tree.ns.cancel')}</Button>,
        <Button key="ok" type="primary" danger={isDrop} disabled={blocked} loading={running} onClick={() => void run()}>
          {isDrop ? t('tree.ns.drop') : t('tree.ns.execute')}
        </Button>,
      ]}
    >
      {!preview && !error && <Spin />}
      {preview && (
        <>
          <div className="muted" style={{ marginBottom: 6 }}>{t('tree.ns.willRun', { name: preview.profile_name })}</div>
          {preview.statements.map((s, i) => <pre key={i} style={SQL_STYLE}>{s};</pre>)}
          {isDrop && <div style={{ marginBottom: 8 }}>{t('tree.ns.dropWarning')}</div>}
          {isDrop && preview.tables !== null && preview.tables > 0 && (
            <div className="err" style={{ marginBottom: 8 }}>
              {change.op === 'drop_schema' && catalog !== undefined ? t('tree.ns.notEmptySqlServer', { n: preview.tables }) : t('tree.ns.notEmpty', { n: preview.tables })}
            </div>
          )}
          {preview.confirm.map((c) => <div key={c} className="muted" style={{ marginBottom: 4 }}>{c}</div>)}
          {preview.confirm_name !== null && (
            <div style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 4 }}>{t('tree.ns.typeName', { name: preview.confirm_name })}</div>
              <Input autoFocus value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          )}
        </>
      )}
      {error && <div className="err" style={{ marginTop: 8 }}>{error}</div>}
    </Modal>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={{ marginBottom: 4 }}>{label}</div>
      {children}
    </div>
  )
}

/** 从对象树新建用户、角色，或删除某个用户、角色（`principalId` 是 Principal.id）。 */
export function PrincipalDialog({ profileId, action, onClose, onDone }: {
  profileId: string
  action: { kind: 'create-user' | 'create-role' } | { kind: 'drop'; principalId: string }
  onClose: () => void
  onDone: () => void
}) {
  const api = useApi()
  const { data, error } = useQuery({
    queryKey: ['privileges', profileId, undefined, 'overview'],
    queryFn: () => api.privilegeOverview(profileId),
  })
  const [change, setChange] = useState<PrivChange | null>(null)
  if (error) {
    return (
      <Modal open onCancel={onClose} footer={null}>
        <div className="err">{(error as Error).message}</div>
      </Modal>
    )
  }
  if (!data) return null
  const principal = action.kind === 'drop' ? data.principals.find((p) => p.id === action.principalId) : undefined
  const current: PrivChange | null = change ?? (principal ? { op: 'drop', principal: principalRef(principal), cascade: false } : null)
  if (!current && action.kind === 'create-user') {
    return <NewUserDialog profileId={profileId} catalog={undefined} caps={data.caps} privCatalog={data.catalog} principals={data.principals} onClose={onClose} onDone={onDone} />
  }
  if (!current) {
    if (action.kind === 'drop') return null
    return (
      <CreateDialog
        role={action.kind === 'create-role'}
        caps={data.caps}
        profileId={profileId}
        roles={data.principals.filter((p) => p.kind === 'role').map((p) => p.name)}
        onCancel={onClose}
        onNext={setChange}
      />
    )
  }
  return (
    <ChangeDialog
      profileId={profileId}
      catalog={undefined}
      change={current}
      cascadable={current.op === 'drop' && data.caps.drop_cascade && current.principal.kind !== 'role'}
      onClose={onClose}
      onDone={onDone}
    />
  )
}
