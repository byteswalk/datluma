// 侧栏标题上的准星按钮：按当前标签在对象树（或模型面板）中定位。定位不了时提示原因。

import { App } from 'antd'
import { IconCurrentLocation } from '@tabler/icons-react'
import { useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import { useUi } from '../../app/ui'
import type { Profile } from '../../shared/api'
import { useRuntime } from '../editor/runner'
import { useTabs } from '../editor/tabs'
import { type RevealTarget, isMiss, revealTargetOf, useReveal } from './reveal'

export default function LocateButton() {
  const api = useApi()
  const qc = useQueryClient()
  const { t } = useTranslation()
  const { message } = App.useApp()

  const locate = async () => {
    const { tabs, active } = useTabs.getState()
    const tab = tabs.find((x) => x.id === active)
    if (!tab) return message.info(t('tree.reveal.noProfile'))
    const profiles = qc.getQueryData<Profile[]>(['profiles']) ?? (await api.profiles())
    let target: RevealTarget | undefined
    // 规范检查结果：查运行记录才知道检查的是库还是模型
    const runId = tab.lint?.view === 'run' ? tab.lint.run : tab.lint?.view === 'diff' ? tab.lint.after : undefined
    if (runId) {
      try {
        const run = await api.lintRun(runId)
        const src = run.source
        if (src?.kind === 'database') target = { panel: 'db', profileId: src.profile, schema: src.schema }
        else if (src?.kind === 'model' && run.model_path) target = { panel: 'models', model: run.model_path, schema: src.schema }
      } catch (e) {
        return message.error((e as Error).message)
      }
      if (!target) return message.info(t('tree.reveal.noProfile'))
    } else {
      const driver = profiles.find((p) => p.id === tab.profileId)?.driver
      const r = revealTargetOf(tab, driver, useRuntime.getState().tabs[tab.id]?.session?.schema)
      if (isMiss(r)) return message.info(t(`tree.reveal.${r.reason}` as const))
      target = r
    }
    if (target.panel === 'db' && !profiles.some((p) => p.id === target.profileId)) {
      return message.info(t('tree.reveal.profileDeleted'))
    }
    if (useUi.getState().side !== target.panel) useUi.getState().setSide(target.panel)
    useReveal.getState().reveal(target)
  }

  return (
    <span className="side-act" title={t('tree.reveal.button')} onClick={() => void locate()}>
      <IconCurrentLocation size={16} />
    </span>
  )
}
