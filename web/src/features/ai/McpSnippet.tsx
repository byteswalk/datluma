// 设置里的 MCP 配置片段：把 DBLENS 作为工具接给本机的智能体（Claude Code、Codex、Cursor 等）。
// 只暴露连接高级选项里打开了“允许 MCP 访问”的连接，查询只允许一条只读语句。

import { App, Button, Form } from 'antd'
import { useTranslation } from 'react-i18next'

import { useShellInfo } from '../../app/useShellInfo'
import { desktop } from '../../shared/shell'

export function mcpConfig(exe: string | null | undefined, isDesktop: boolean): string {
  const server = isDesktop
    ? { command: exe || 'DBLENS.exe', args: ['--mcp'] }
    : { command: 'dblens-server', args: ['mcp'] }
  return JSON.stringify({ mcpServers: { dblens: server } }, null, 2)
}

export default function McpSnippet() {
  const { t } = useTranslation()
  const { message } = App.useApp()
  const info = useShellInfo()
  const text = mcpConfig(info?.exe, !!desktop)
  return (
    <Form.Item label="MCP" extra={t('ai.mcp.hint')}>
      <div className="ai-code">
        <Button
          size="small"
          type="text"
          className="ai-code-copy"
          onClick={() =>
            void navigator.clipboard.writeText(text).then(
              () => message.success(t('ai.dialog.copied')),
              () => message.error(t('ai.dialog.copyFailed')),
            )
          }
        >
          {t('ai.dialog.copy')}
        </Button>
        <pre>{text}</pre>
      </div>
    </Form.Item>
  )
}
