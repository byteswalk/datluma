// AI 结果弹窗的状态（AI 设计文档“界面”一节）：各入口都打开同一个弹窗，给出请求和可用的操作。
// 回答只是建议：SQL 由用户插入编辑器或复制，注释由用户在设计器里保存，从不自动执行。

import { useQuery } from '@tanstack/react-query'
import { create } from 'zustand'

import { useApi } from '../../app/context'
import type { AiAskRequest, AiAskResponse } from '../../shared/api'

export interface AiAction {
  label: string
  /** 回答里没有 SQL 时是否禁用。 */
  needsSql?: boolean
  run(r: AiAskResponse): void
}

export interface AiDialogOptions {
  title: string
  req: AiAskRequest
  /** 先让用户写需求（`generate`），写好后作为 `instruction` 发出。 */
  askInstruction?: boolean
  actions?: AiAction[]
}

interface AiDialogState {
  opts: AiDialogOptions | null
  /** 每次打开加一，弹窗据此重新提问。 */
  n: number
  open(opts: AiDialogOptions): void
  close(): void
}

export const useAiDialog = create<AiDialogState>()((set, get) => ({
  opts: null,
  n: 0,
  open: (opts) => set({ opts, n: get().n + 1 }),
  close: () => set({ opts: null }),
}))

export const AI_CONFIG_KEY = ['ai', 'config'] as const

/** 提供方配置；接口不可用（老版本服务端）时当作未启用。 */
export function useAiConfig() {
  const api = useApi()
  return useQuery({ queryKey: AI_CONFIG_KEY, queryFn: () => api.aiConfig(), staleTime: 60_000, retry: false })
}

/** 是否显示 AI 入口：启用了提供方。 */
export function useAiEnabled(): boolean {
  return useAiConfig().data?.config.enabled ?? false
}

/** 回答拆成文字和代码块，代码块单独显示。 */
export function splitAnswer(text: string): { code: boolean; lang: string; text: string }[] {
  const out: { code: boolean; lang: string; text: string }[] = []
  const re = /```([^\n`]*)\n([\s\S]*?)```/g
  let last = 0
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) out.push({ code: false, lang: '', text: text.slice(last, m.index) })
    out.push({ code: true, lang: m[1].trim(), text: dedent(m[2].replace(/\n[ \t]*$/, '')) })
    last = m.index + m[0].length
  }
  if (last < text.length) out.push({ code: false, lang: '', text: text.slice(last) })
  return out.filter((p) => p.code || p.text.trim())
}

/** 去掉各行共同的前导空白（代码块嵌在列表里时带着缩进）。 */
function dedent(code: string): string {
  const lines = code.split('\n')
  const indents = lines.filter((l) => l.trim()).map((l) => /^[ \t]*/.exec(l)![0].length)
  const n = indents.length ? Math.min(...indents) : 0
  return n ? lines.map((l) => l.slice(n)).join('\n') : code
}

export type ProsePart = { kind: 'text' | 'bold' | 'code'; text: string }
export type ProseLine = { kind: 'rule' } | { kind: 'line' | 'heading'; parts: ProsePart[] }

/** 把回答文字按行拆开，认出标题、分隔线、粗体和行内代码。 */
export function proseLines(text: string): ProseLine[] {
  return text.split('\n').map((raw) => {
    const line = raw.trimEnd()
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) return { kind: 'rule' }
    const heading = /^\s*#{1,6}\s+(.*)$/.exec(line)
    const body = heading ? heading[1] : line
    const parts: ProsePart[] = []
    for (const piece of body.split(/(\*\*.+?\*\*|`[^`]+`)/)) {
      if (!piece) continue
      if (piece.startsWith('**') && piece.endsWith('**') && piece.length > 4) parts.push({ kind: 'bold', text: piece.slice(2, -2) })
      else if (piece.startsWith('`') && piece.endsWith('`') && piece.length > 2) parts.push({ kind: 'code', text: piece.slice(1, -1) })
      else parts.push({ kind: 'text', text: piece })
    }
    return { kind: heading ? 'heading' : 'line', parts }
  })
}
