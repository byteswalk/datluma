// 一组改动（权限矩阵的勾选、加减角色）一起预览、确认、执行：后端按顺序逐条执行，失败即停。
// 生产连接上有高风险改动时只要输入一次名称。

import { Alert, Button, Input, Modal, Spin } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import type { PrivApplyResult, PrivChange, PrivPreview } from '../../shared/api'

const SQL_STYLE = { whiteSpace: 'pre-wrap', margin: '0 0 8px', fontFamily: 'var(--mono)', maxHeight: 320, overflow: 'auto' } as const

export function BatchDialog({ profileId, catalog, changes: initial, onClose, onDone }: {
  profileId: string
  catalog: string | undefined
  changes: PrivChange[]
  onClose: () => void
  /** 执行过（哪怕中途失败）：已成功的改动已生效，调用方要刷新并清掉待提交的改动。 */
  onDone: (result: PrivApplyResult) => void
}) {
  const api = useApi()
  const { t } = useTranslation()
  // 打开时固定这组改动：执行后调用方会清空待提交的改动，不能跟着变
  const [changes] = useState(initial)
  const [preview, setPreview] = useState<PrivPreview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [typed, setTyped] = useState('')
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<PrivApplyResult | null>(null)

  useEffect(() => {
    let live = true
    api.privilegePreviewBatch(profileId, changes, catalog).then(
      (p) => live && setPreview(p),
      (e: Error) => live && setError(e.message),
    )
    return () => {
      live = false
    }
  }, [api, profileId, catalog, changes])

  const blocked = !preview || (preview.confirm_name != null && typed !== preview.confirm_name)
  const run = async () => {
    setRunning(true)
    setError(null)
    try {
      const r = await api.privilegeApplyBatch(profileId, changes, catalog, preview?.confirm_name ? typed : undefined)
      setResult(r)
      onDone(r)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }
  const finished = result !== null
  return (
    <Modal
      open
      width={680}
      title={t('privilege.batch.title', { n: changes.length })}
      onCancel={onClose}
      destroyOnHidden
      footer={
        finished
          ? [<Button key="close" type="primary" onClick={onClose}>{t('privilege.change.close')}</Button>]
          : [
              <Button key="cancel" onClick={onClose}>{t('privilege.change.cancel')}</Button>,
              <Button key="run" type="primary" disabled={blocked} loading={running} onClick={() => void run()}>{t('privilege.change.run')}</Button>,
            ]
      }
    >
      {error && <Alert type="error" showIcon message={error} style={{ marginBottom: 8 }} />}
      {!preview && !error && <Spin style={{ display: 'block', margin: '24px auto' }} />}
      {preview && !finished && (
        <>
          <div className="muted" style={{ marginBottom: 4 }}>{t('privilege.change.connection', { name: preview.profile_name })}</div>
          <pre style={SQL_STYLE}>{preview.statements.join(';\n')};</pre>
          {preview.statements.length > 1 && <div className="muted" style={{ marginBottom: 8 }}>{t('privilege.change.notAtomic')}</div>}
          {preview.own_account && <Alert type="warning" showIcon message={t('privilege.change.ownAccount')} style={{ marginBottom: 8 }} />}
          {preview.confirm.map((m) => <Alert key={m} type="warning" showIcon message={m} style={{ marginBottom: 8 }} />)}
          {preview.confirm_name != null && (
            <div style={{ marginTop: 8 }}>
              <div style={{ marginBottom: 4 }}>{t('privilege.change.typeName', { name: preview.confirm_name })}</div>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </div>
          )}
        </>
      )}
      {result && (
        <>
          {result.done.length > 0 && (
            <>
              <div style={{ marginBottom: 4 }}>{t('privilege.change.done')}</div>
              <pre style={SQL_STYLE}>{result.done.join(';\n')};</pre>
            </>
          )}
          {result.error && <Alert type="error" showIcon message={t('privilege.change.failed', { statement: result.failed })} description={result.error} />}
        </>
      )}
    </Modal>
  )
}
