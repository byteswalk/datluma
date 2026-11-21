// 设置里的 AI 页：提供方（OpenAI 兼容 / Anthropic / 本机命令行）、地址、模型、API key、超时，测试连通。
// 审计版由管理员固定配置，这里只显示状态。

import { useQueryClient } from '@tanstack/react-query'
import { Alert, App, AutoComplete, Button, Form, Input, InputNumber, Radio, Switch } from 'antd'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import { type AiProviderConfig, ApiError, errorText } from '../../shared/api'
import McpSnippet from './McpSnippet'
import { AI_CONFIG_KEY, useAiConfig } from './store'

/** 常用的 OpenAI 兼容接口地址。 */
const PRESETS = [
  { value: 'https://api.deepseek.com/v1', label: 'DeepSeek  https://api.deepseek.com/v1' },
  { value: 'https://dashscope.aliyuncs.com/compatible-mode/v1', label: '通义千问  https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { value: 'https://open.bigmodel.cn/api/paas/v4', label: '智谱  https://open.bigmodel.cn/api/paas/v4' },
  { value: 'https://api.moonshot.cn/v1', label: 'Kimi  https://api.moonshot.cn/v1' },
  { value: 'https://api.openai.com/v1', label: 'OpenAI  https://api.openai.com/v1' },
  { value: 'http://localhost:11434/v1', label: 'Ollama  http://localhost:11434/v1' },
]

const DEFAULT: AiProviderConfig = { enabled: false, kind: 'openai', timeout_secs: 120 }

export default function AiSettings() {
  const { t } = useTranslation()
  const api = useApi()
  const qc = useQueryClient()
  const { message } = App.useApp()
  const view = useAiConfig()
  const [cfg, setCfg] = useState<AiProviderConfig>(DEFAULT)
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState<'save' | 'test' | null>(null)
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => {
    if (view.data) setCfg({ ...DEFAULT, ...view.data.config })
  }, [view.data])

  if (view.isError) return <Alert type="warning" message={t('ai.settings.unavailable')} />
  const v = view.data
  if (!v) return null
  if (!v.configurable) {
    return (
      <Alert
        type="info"
        message={v.config.enabled ? t('ai.settings.managedOn') : t('ai.settings.managedOff')}
        description={t('ai.settings.managedHint')}
      />
    )
  }
  const set = (patch: Partial<AiProviderConfig>) => {
    setCfg((c) => ({ ...c, ...patch }))
    setTest(null)
  }
  const fail = (e: unknown) => (e instanceof ApiError ? errorText(e.body) : String(e))
  const save = async () => {
    setBusy('save')
    try {
      if (key.trim()) await api.setAiKey(key.trim())
      const next = await api.setAiConfig(cfg)
      qc.setQueryData(AI_CONFIG_KEY, next)
      setKey('')
      message.success(t('ai.settings.saved'))
      return true
    } catch (e) {
      message.error(fail(e))
      return false
    } finally {
      setBusy(null)
    }
  }
  const runTest = async () => {
    // 先保存（测试用已保存的配置），再问一句
    if (!(await save())) return
    setBusy('test')
    try {
      setTest({ ok: true, text: await api.aiTest() })
    } catch (e) {
      setTest({ ok: false, text: fail(e) })
    } finally {
      setBusy(null)
    }
  }
  const clearKey = async () => {
    try {
      qc.setQueryData(AI_CONFIG_KEY, await api.setAiKey(null))
    } catch (e) {
      message.error(fail(e))
    }
  }
  const cli = cfg.kind === 'cli'
  return (
    <Form layout="horizontal" labelCol={{ span: 6 }} style={{ marginTop: 8 }}>
      <Form.Item label={t('ai.settings.enabled')} extra={t('ai.settings.enabledHint')}>
        <Switch checked={cfg.enabled} onChange={(enabled) => set({ enabled })} />
      </Form.Item>
      <Form.Item label={t('ai.settings.kind')}>
        <Radio.Group
          value={cfg.kind}
          onChange={(e) => set({ kind: e.target.value })}
          options={[
            { value: 'openai', label: t('ai.settings.kindOpenai') },
            { value: 'anthropic', label: 'Anthropic' },
            ...(v.cli_allowed || cli ? [{ value: 'cli', label: t('ai.settings.kindCli') }] : []),
          ]}
        />
      </Form.Item>
      {cli ? (
        <Form.Item label={t('ai.settings.command')} extra={t('ai.settings.commandHint')}>
          <Input
            value={cfg.command ?? ''}
            onChange={(e) => set({ command: e.target.value })}
            placeholder="codex exec  /  gemini  /  claude -p"
          />
        </Form.Item>
      ) : (
        <>
          <Form.Item
            label={t('ai.settings.baseUrl')}
            extra={cfg.kind === 'openai' ? t('ai.settings.baseUrlHint') : t('ai.settings.baseUrlAnthropicHint')}
          >
            <AutoComplete
              value={cfg.base_url ?? ''}
              onChange={(v) => set({ base_url: v })}
              options={cfg.kind === 'openai' ? PRESETS : []}
              placeholder={cfg.kind === 'openai' ? 'http://localhost:11434/v1' : 'https://api.anthropic.com'}
            />
          </Form.Item>
          <Form.Item label={t('ai.settings.model')}>
            <Input value={cfg.model ?? ''} onChange={(e) => set({ model: e.target.value })} />
          </Form.Item>
          <Form.Item label="API key" extra={t('ai.settings.keyHint')}>
            <div className="row" style={{ gap: 8 }}>
              <Input.Password
                value={key}
                onChange={(e) => setKey(e.target.value)}
                placeholder={v.has_key ? t('ai.settings.keySaved') : t('ai.settings.keyEmpty')}
                autoComplete="new-password"
              />
              {v.has_key && (
                <Button onClick={() => void clearKey()}>{t('ai.settings.keyClear')}</Button>
              )}
            </div>
          </Form.Item>
        </>
      )}
      <Form.Item label={t('ai.settings.timeout')}>
        <InputNumber
          min={5}
          max={1800}
          value={cfg.timeout_secs}
          onChange={(n) => set({ timeout_secs: n ?? 120 })}
          addonAfter={t('ai.settings.seconds')}
          style={{ width: 160 }}
        />
      </Form.Item>
      <Form.Item wrapperCol={{ offset: 6 }}>
        <div className="row" style={{ gap: 8 }}>
          <Button type="primary" loading={busy === 'save'} disabled={!!busy} onClick={() => void save()}>
            {t('ai.settings.save')}
          </Button>
          <Button loading={busy === 'test'} disabled={!!busy || !cfg.enabled} onClick={() => void runTest()}>
            {t('ai.settings.test')}
          </Button>
        </div>
        {test && (
          <Alert
            style={{ marginTop: 8 }}
            type={test.ok ? 'success' : 'error'}
            message={test.ok ? t('ai.settings.testOk', { reply: test.text }) : test.text}
          />
        )}
      </Form.Item>
      <Form.Item wrapperCol={{ offset: 6 }}>
        <div className="muted" style={{ fontSize: 12 }}>
          {t('ai.settings.boundary')}
        </div>
      </Form.Item>
      <McpSnippet />
    </Form>
  )
}
