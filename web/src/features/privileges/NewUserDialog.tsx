// 一步新建用户：名称、密码、（Oracle、达梦的）表空间、所属角色、常用权限预设都在一个框里，底部实时显示要执行的语句，
// 点"执行"就建好，不再弹第二个确认框。密码只在组件状态里，预览里是 ***。

import { Alert, Button, Input, Modal, Radio, Select, Spin } from 'antd'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import { joinCatalog } from '../../shared/api'
import type { Principal, PrincipalRef, PrivApplyResult, PrivCaps, PrivCatalog, PrivChange, PrivPreview, UserOptions } from '../../shared/api'
import { Field, PasswordField, StorageFields } from './PrivilegeDialogs'
import { objectTarget, scopeTarget } from './matrix'

const SQL_STYLE = { whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'var(--mono)', maxHeight: 200, overflow: 'auto' } as const

type Preset = 'none' | 'read' | 'write'
// 查询没有结果时用的固定空数组：每次渲染都 `= []` 会得到新数组，改动列表跟着重算、预览请求停不下来
const NONE: string[] = []
const NO_SCHEMAS: { name: string; is_system: boolean }[] = []
const PRESET_PRIVS: Record<Exclude<Preset, 'none'>, string[]> = {
  read: ['SELECT'],
  write: ['SELECT', 'INSERT', 'UPDATE', 'DELETE'],
}

/** Oracle、达梦新建用户时默认带上的角色（库里有才选）。 */
function defaultRoles(caps: PrivCaps, roles: string[]): string[] {
  if (!caps.user_storage) return []
  const wanted = caps.user_temp_quota ? ['CONNECT', 'RESOURCE'] : ['RESOURCE']
  return wanted.filter((r) => roles.includes(r))
}

export default function NewUserDialog({ profileId, catalog, caps, privCatalog, principals, onClose, onDone }: {
  profileId: string
  catalog: string | undefined
  caps: PrivCaps
  privCatalog: PrivCatalog
  principals: Principal[]
  onClose: () => void
  /** 建好后：参数是新用户的名字（调用方可以选中它）。 */
  onDone: (name: string) => void
}) {
  const api = useApi()
  const { t } = useTranslation()
  const roles = useMemo(() => principals.filter((p) => p.kind === 'role'), [principals])
  const [name, setName] = useState('')
  const [host, setHost] = useState('%')
  const [password, setPassword] = useState('')
  const [storage, setStorage] = useState<UserOptions | null>(null)
  const [picked, setPicked] = useState<string[]>(() => defaultRoles(caps, roles.map((r) => r.name)))
  const [preset, setPreset] = useState<Preset>('none')
  const [schema, setSchema] = useState<string | undefined>(undefined)
  const { data: schemas = NO_SCHEMAS } = useQuery({ queryKey: ['schemas', profileId, catalog], queryFn: () => api.schemas(profileId, undefined, catalog) })
  const userSchemas = useMemo(() => schemas.filter((s) => !s.is_system).map((s) => s.name), [schemas])
  useEffect(() => {
    if (schema === undefined && userSchemas.length) setSchema(userSchemas[0])
  }, [userSchemas, schema])
  // 预设授权按模式给：能按模式授权的库（MySQL、SQL Server）一条语句，其余库对模式里的每个表、视图授权
  const bySchema = preset !== 'none' && PRESET_PRIVS[preset].every((p) => privCatalog.schema.includes(p))
  const key = schema === undefined ? undefined : catalog === undefined ? schema : joinCatalog(catalog, schema)
  const { data: objects = NONE } = useQuery({
    queryKey: ['privileges', profileId, 'matrix-objects-names', key],
    enabled: preset !== 'none' && !bySchema && key !== undefined,
    queryFn: async () => {
      const [tables, views] = await Promise.all([api.objects(profileId, key!, 'tables'), api.objects(profileId, key!, 'views').catch(() => [])])
      return [...tables, ...views].map((o) => o.name)
    },
  })

  const changes = useMemo((): PrivChange[] => {
    if (!name.trim() || (!caps.os_accounts && !password)) return []
    const me: PrincipalRef = { name: name.trim(), host: caps.host ? host : null, kind: 'user', level: 'server' }
    const out: PrivChange[] = [
      { op: 'create_user', name: name.trim(), host: caps.host ? host : undefined, password, ...(caps.user_storage && storage ? { options: { ...storage, roles: [] } } : {}) },
    ]
    for (const r of roles.filter((x) => picked.includes(x.name))) {
      out.push({ op: 'add_role', member: { ...me, level: r.level }, role: { name: r.name, host: r.host, kind: r.kind, level: r.level } })
    }
    if (preset !== 'none' && schema !== undefined) {
      const privilege = PRESET_PRIVS[preset].join(', ')
      // PG 系要先能用这个模式
      if (!bySchema && privCatalog.schema.includes('USAGE')) out.push({ op: 'grant', grantee: me, scope: 'schema', target: scopeTarget('schema', schema), privilege: 'USAGE' })
      if (bySchema) out.push({ op: 'grant', grantee: me, scope: 'schema', target: scopeTarget('schema', schema), privilege })
      else for (const o of objects) out.push({ op: 'grant', grantee: me, scope: 'object', target: objectTarget(schema, o), privilege })
    }
    return out
  }, [name, host, password, storage, picked, preset, schema, objects, bySchema, caps, roles, privCatalog])

  // 填好必填项后，停 400 毫秒再生成预览
  const [preview, setPreview] = useState<PrivPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setPreview(null)
    setError(null)
    if (!changes.length) return
    let live = true
    const timer = setTimeout(() => {
      api.privilegePreviewBatch(profileId, changes, catalog).then(
        (p) => live && setPreview(p),
        (e: Error) => live && setError(e.message),
      )
    }, 400)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [api, profileId, catalog, changes])

  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<PrivApplyResult | null>(null)
  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const r = await api.privilegeApplyBatch(profileId, changes, catalog, preview?.confirm_name ? typed : undefined)
      setResult(r)
      onDone(name.trim())
      if (!r.error) onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }
  const blocked = !preview || running || (preview.confirm_name != null && typed !== preview.confirm_name)

  return (
    <Modal
      open
      width={600}
      title={t('privilege.action.newUser')}
      onCancel={onClose}
      destroyOnHidden
      footer={[
        <Button key="cancel" onClick={onClose}>{t('privilege.change.cancel')}</Button>,
        <Button key="run" type="primary" disabled={blocked} loading={running} onClick={() => void run()}>{t('privilege.change.run')}</Button>,
      ]}
    >
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}><Field label={t('privilege.attr.name')}><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" /></Field></div>
        {caps.host && <div style={{ width: 140 }}><Field label={t('privilege.attr.host')}><Input value={host} onChange={(e) => setHost(e.target.value)} /></Field></div>}
      </div>
      <Field label={t('privilege.action.password')}><PasswordField value={password} onChange={setPassword} /></Field>
      {caps.os_accounts && <div className="muted" style={{ marginBottom: 10 }}>{t('privilege.action.osAccountHint')}</div>}
      {caps.user_storage && <StorageFields profileId={profileId} caps={caps} roles={[]} value={storage} onChange={setStorage} showRoles={false} />}
      {caps.roles && roles.length > 0 && (
        <Field label={t('privilege.newUser.roles')}>
          <Select mode="multiple" allowClear value={picked} onChange={setPicked} options={roles.map((r) => ({ value: r.name, label: r.name }))} style={{ width: '100%' }} />
        </Field>
      )}
      <Field label={t('privilege.newUser.preset')}>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <Radio.Group
            optionType="button"
            size="small"
            value={preset}
            onChange={(e) => setPreset(e.target.value)}
            options={(['none', 'read', 'write'] as const).map((p) => ({ value: p, label: t(`privilege.newUser.${p}`) }))}
          />
          {preset !== 'none' && <Select size="small" style={{ width: 200 }} showSearch value={schema} onChange={setSchema} options={userSchemas.map((s) => ({ value: s, label: s }))} />}
        </div>
      </Field>
      <div style={{ marginTop: 4 }}>
        <div className="muted" style={{ marginBottom: 4 }}>{t('privilege.newUser.sql')}</div>
        <div className="sql-preview-box">
          {!changes.length ? (
            <span className="muted">{t('privilege.newUser.fillFirst')}</span>
          ) : preview ? (
            <pre style={SQL_STYLE}>{preview.statements.join(';\n')};</pre>
          ) : error ? null : (
            <Spin size="small" />
          )}
        </div>
      </div>
      {error && <Alert type="error" showIcon message={error} style={{ marginTop: 8 }} />}
      {result?.error && <Alert type="error" showIcon style={{ marginTop: 8 }} message={t('privilege.change.failed', { statement: result.failed })} description={result.error} />}
      {preview?.confirm.map((m) => <Alert key={m} type="warning" showIcon message={m} style={{ marginTop: 8 }} />)}
      {preview?.confirm_name != null && (
        <div style={{ marginTop: 8 }}>
          <div style={{ marginBottom: 4 }}>{t('privilege.change.typeName', { name: preview.confirm_name })}</div>
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
        </div>
      )}
    </Modal>
  )
}
