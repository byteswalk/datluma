// 显示原生这边推来的提示（检查更新、关于），用和主题一致的弹框，不用系统消息框。

import { App } from 'antd'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { type Notice, desktop } from '../shared/shell'

export default function NoticeHost() {
  const { modal } = App.useApp()
  const { t } = useTranslation()
  useEffect(() => {
    if (!desktop) return
    const shown = new Set<number>()
    const show = (n: Notice) => {
      if (shown.has(n.id)) return
      shown.add(n.id)
      const reply = (ok: boolean) => void desktop?.replyNotice(n.id, ok).catch(console.warn)
      const content = <div style={{ whiteSpace: 'pre-wrap', userSelect: 'text' }}>{n.text}</div>
      const common = { title: t('common.appName'), content, centered: true }
      if (n.ok && n.cancel) {
        modal.confirm({ ...common, okText: n.ok, cancelText: n.cancel, onOk: () => reply(true), onCancel: () => reply(false) })
      } else {
        const open = n.kind === 'error' ? modal.error : modal.info
        open({ ...common, okText: t('app.notice.ok'), onOk: () => reply(true), onCancel: () => reply(false) })
      }
    }
    let stop: (() => void) | undefined
    let cancelled = false
    void desktop.onNotice(show).then((un) => (cancelled ? un() : (stop = un)))
    void desktop.pendingNotices().then((list) => list.forEach(show), console.warn)
    return () => {
      cancelled = true
      stop?.()
    }
  }, [modal, t])
  return null
}
