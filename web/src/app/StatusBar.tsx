// 状态栏（M1 设计文档 1.1 节）：有查询标签时显示它的连接和方言、事务状态、最近一次执行的行数和耗时、
// 语法问题数（点击跳到第一处）、光标位置；没有时显示对象树中选中的连接。

import { IconAlertTriangle, IconPlugConnected } from '@tabler/icons-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'

import { driverLabel, profileKind } from '../features/connections/form'
import { sendCommand } from '../features/editor/commands'
import { useCursor } from '../features/editor/cursor'
import { variantName } from '../features/editor/dialect'
import { useTabRuntime } from '../features/editor/runner'
import { useTabs } from '../features/editor/tabs'
import { useSyntax } from '../features/sql/syntax'
import DbIcon from '../shared/DbIcon'
import EnvTag from '../shared/EnvTag'
import { lastSummary } from '../features/results/results'
import type { Profile } from '../shared/api'
import { useApi } from './context'
import { useUi } from './ui'

function TabStatus({ tabId, profile }: { tabId: string; profile: Profile | undefined }) {
  const { t } = useTranslation()
  const rt = useTabRuntime(tabId)
  const cursor = useCursor()
  const s = rt.session
  const dialect = variantName(s?.variant) ?? (profile && driverLabel(profile.driver))
  const summary = lastSummary(rt.exec)
  const syntax = useSyntax((x) => x.tabs[tabId])
  return (
    <>
      <span className="row" style={{ gap: 4 }}>
        {profile ? <DbIcon driver={profile.driver} variant={s?.variant ?? profile.variant} /> : <IconPlugConnected size={14} />}
        {profile?.name ?? t('app.status.connectionDeleted')}
        {s?.schema && <span className="muted">· {s.schema}</span>}
        {hasEnv(profile) && <EnvTag env={profile.environment} />}
      </span>
      {s && (
        <span style={{ color: s.in_transaction ? 'var(--warn)' : undefined }}>
          {s.autocommit
            ? t('app.status.autocommit')
            : s.in_transaction
              ? t('app.status.inTransaction')
              : t('app.status.manualCommit')}
        </span>
      )}
      {rt.running ? <span>{t('app.status.running')}</span> : summary && <span>{summary}</span>}
      <span className="grow" />
      {syntax?.status === 'ok' && syntax.count > 0 && (
        <span className="row" style={{ gap: 4, color: 'var(--warn)', cursor: 'pointer' }} onClick={() => sendCommand('first-problem')}>
          <IconAlertTriangle size={14} />
          {t('app.status.syntaxIssues', { count: syntax.count })}
        </span>
      )}
      {syntax?.status === 'stopped' && <span className="muted">{t('app.status.syntaxStopped')}</span>}
      {syntax?.status === 'skipped' && <span className="muted">{t('app.status.syntaxSkipped')}</span>}
      <span>{t('app.status.cursor', { line: cursor.line, column: cursor.column })}</span>
      {dialect && <span>{dialect}</span>}
      <span>UTF-8</span>
    </>
  )
}

/** 连接设了环境（开发、测试、生产）吗。 */
function hasEnv(p: Profile | undefined): p is Profile {
  return !!p?.environment && p.environment !== 'none'
}

/** 状态栏底色跟着连接的环境走（shell.css 的 .statusbar.env-*），未设环境和没有连接时用默认的浅灰。 */
function barClass(p: Profile | undefined): string {
  return hasEnv(p) ? `row statusbar env-${p.environment}` : 'row statusbar'
}

export default function StatusBar() {
  const { t } = useTranslation()
  const api = useApi()
  const selected = useUi((s) => s.selectedProfile)
  const active = useTabs((s) => s.tabs.find((t) => t.id === s.active))
  const { data: profiles } = useQuery({ queryKey: ['profiles'], queryFn: () => api.profiles() })
  // 模型的设计器标签、比对标签不绑定连接：显示模型目录
  if (active && !active.profileId) {
    return (
      <div className="row statusbar">
        <span className="muted">{active.design?.model ?? (active.er?.kind === 'model' ? active.er.path : active.lint ? t('lint.start.title') : active.migrate ? t('migrate.title') : t('model.compare.title'))}</span>
        <span className="grow" />
      </div>
    )
  }
  if (active) {
    const profile = profiles?.find((x) => x.id === active.profileId)
    return (
      <div className={barClass(profile)}>
        <TabStatus tabId={active.id} profile={profile} />
      </div>
    )
  }
  const p = profiles?.find((x) => x.id === selected)
  return (
    <div className={barClass(p)}>
      {p ? (
        <span className="row" style={{ gap: 4 }}>
          <DbIcon driver={p.driver} variant={profileKind(p).icon} />
          {p.name} · {profileKind(p).label} · {p.user}@{p.host}:{p.port}
          {hasEnv(p) && <EnvTag env={p.environment} />}
        </span>
      ) : (
        <span className="muted">{t('app.status.noConnection')}</span>
      )}
      <span className="grow" />
    </div>
  )
}
