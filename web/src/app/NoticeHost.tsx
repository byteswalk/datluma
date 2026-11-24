// 显示原生这边推来的提示（检查更新、关于）和第一次关闭时的询问，用和主题一致的弹框，不用系统消息框。

import { App, Button } from 'antd'
import { useEffect } from 'react'
import { useTranslation } from 'react-i18next'

import { type CloseAction, type Notice, desktop } from '../shared/shell'

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
    // 第一次点关闭：问最小化到托盘还是退出，记住选择后照此执行；右上角的 × 或 Esc 表示不关了
    let asking = false
    const askClose = () => {
      if (asking) return
      asking = true
      const choose = (action: CloseAction) => {
        dialog.destroy()
        void desktop
          ?.setCloseAction(action)
          .then(() => desktop?.action('close'))
          .catch(console.warn)
      }
      const dialog = modal.confirm({
        title: t('app.closeAsk.title'),
        content: t('app.closeAsk.content'),
        centered: true,
        closable: true,
        afterClose: () => (asking = false),
        footer: (
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
            <Button onClick={() => choose('quit')}>{t('app.closeAsk.quit')}</Button>
            <Button type="primary" onClick={() => choose('tray')}>
              {t('app.closeAsk.tray')}
            </Button>
          </div>
        ),
      })
    }
    let stopClose: (() => void) | undefined
    let stop: (() => void) | undefined
    let cancelled = false
    void desktop.onCloseRequested(askClose).then((un) => (cancelled ? un() : (stopClose = un)))
    void desktop.onNotice(show).then((un) => (cancelled ? un() : (stop = un)))
    void desktop.pendingNotices().then((list) => list.forEach(show), console.warn)
    return () => {
      cancelled = true
      stop?.()
      stopClose?.()
    }
  }, [modal, t])
  return null
}
