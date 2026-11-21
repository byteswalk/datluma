// AI 结果弹窗：发出请求、显示回答（文字和代码块分开）、给出入口传来的操作（插入编辑器等）和复制。

import { useMutation } from '@tanstack/react-query'
import { Alert, App, Button, Input, Modal, Spin } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import { useUi } from '../../app/ui'
import { type AiAskResponse, ApiError, errorText } from '../../shared/api'
import { proseLines, splitAnswer, useAiDialog } from './store'

export default function AiDialog() {
  const { t } = useTranslation()
  const api = useApi()
  const { message } = App.useApp()
  const { opts, n, close } = useAiDialog()
  const [instruction, setInstruction] = useState('')
  const ask = useMutation({
    mutationFn: (instruction?: string) =>
      api.aiAsk(instruction === undefined ? opts!.req : { ...opts!.req, instruction }),
  })
  const { reset, mutate } = ask
  useEffect(() => {
    reset()
    setInstruction(opts?.req.instruction ?? '')
    if (opts && !opts.askInstruction) mutate(undefined)
  }, [n]) // 每次打开重新提问

  if (!opts) return null
  const send = () => instruction.trim() && ask.mutate(instruction.trim())
  const r = ask.data
  const copy = (text: string) =>
    navigator.clipboard.writeText(text).then(
      () => message.success(t('ai.dialog.copied')),
      () => message.error(t('ai.dialog.copyFailed')),
    )
  const err = ask.error instanceof ApiError ? errorText(ask.error.body) : ask.error ? String(ask.error.message) : null
  const notConfigured = ask.error instanceof ApiError && ask.error.body.kind === 'invalid' && !r

  return (
    <Modal
      title={opts.title}
      open
      width={760}
      onCancel={close}
      destroyOnHidden
      footer={
        <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
          <span className="muted grow" style={{ textAlign: 'left', fontSize: 12 }}>
            {t('ai.dialog.disclaimer')}
          </span>
          {r?.sql && <Button onClick={() => void copy(r.sql!)}>{t('ai.dialog.copySql')}</Button>}
          {(opts.actions ?? []).map((a) => (
            <Button
              key={a.label}
              type="primary"
              disabled={!r || (a.needsSql && !r.sql)}
              onClick={() => {
                a.run(r as AiAskResponse)
                close()
              }}
            >
              {a.label}
            </Button>
          ))}
          <Button onClick={close}>{t('ai.dialog.close')}</Button>
        </div>
      }
    >
      {opts.askInstruction && (
        <div style={{ marginBottom: 12 }}>
          <Input.TextArea
            autoFocus
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            placeholder={t('ai.dialog.instructionPlaceholder')}
            autoSize={{ minRows: 2, maxRows: 6 }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault()
                send()
              }
            }}
          />
          <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
            <Button type="primary" loading={ask.isPending} disabled={!instruction.trim()} onClick={send}>
              {t('ai.dialog.send')}
            </Button>
          </div>
        </div>
      )}
      {ask.isPending && (
        <div className="row" style={{ gap: 8, padding: '24px 0', justifyContent: 'center' }}>
          <Spin size="small" />
          <span className="muted">{t('ai.dialog.thinking')}</span>
        </div>
      )}
      {err && (
        <Alert
          type="error"
          showIcon
          message={err}
          action={
            notConfigured ? (
              <Button
                size="small"
                onClick={() => {
                  close()
                  useUi.getState().setSettingsOpen(true)
                }}
              >
                {t('ai.dialog.openSettings')}
              </Button>
            ) : (
              <Button size="small" onClick={() => ask.mutate(opts.askInstruction ? instruction.trim() : undefined)}>
                {t('ai.dialog.retry')}
              </Button>
            )
          }
        />
      )}
      {r && <Answer r={r} onCopy={copy} />}
    </Modal>
  )
}

function Answer({ r, onCopy }: { r: AiAskResponse; onCopy(text: string): void }) {
  const { t } = useTranslation()
  if (r.comments) {
    return r.comments.every((c) => !c.comment && !Object.keys(c.columns).length) ? (
      <Alert type="info" message={t('ai.comments.none')} />
    ) : (
      <div className="ai-answer">
        {r.comments.map((c) => (
          <div key={c.table} style={{ marginBottom: 12 }}>
            <div>
              <b>{c.table}</b>
              {c.comment && <span className="muted"> — {c.comment}</span>}
            </div>
            {Object.entries(c.columns).map(([col, text]) => (
              <div key={col} style={{ paddingLeft: 16 }}>
                <code>{col}</code> <span className="muted">—</span> {text}
              </div>
            ))}
          </div>
        ))}
      </div>
    )
  }
  return (
    <div className="ai-answer">
      {splitAnswer(r.text).map((p, i) =>
        p.code ? (
          <div key={i} className="ai-code">
            <Button size="small" type="text" className="ai-code-copy" onClick={() => onCopy(p.text)}>
              {t('ai.dialog.copy')}
            </Button>
            <pre>{p.text}</pre>
          </div>
        ) : (
          <div key={i} className="ai-text">
            <Prose text={p.text.trim()} />
          </div>
        ),
      )}
    </div>
  )
}

/** 回答里的文字：只认标题、粗体、行内代码、分隔线，其他照原样显示（不解析 HTML）。 */
function Prose({ text }: { text: string }) {
  return (
    <>
      {proseLines(text).map((l, i) =>
        l.kind === 'rule' ? (
          <hr key={i} className="ai-rule" />
        ) : (
          <div key={i} className={l.kind === 'heading' ? 'ai-heading' : undefined}>
            {l.parts.length
              ? l.parts.map((p, j) =>
                  p.kind === 'bold' ? <b key={j}>{p.text}</b> : p.kind === 'code' ? <code key={j}>{p.text}</code> : p.text,
                )
              : ' '}
          </div>
        ),
      )}
    </>
  )
}
