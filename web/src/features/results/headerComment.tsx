// 结果表格的列头悬停提示：列有注释时显示注释。查询结果（ResultGrid）和数据标签（EditableGrid）共用。
// 表格画在 canvas 上，列头不是 DOM 元素：按悬停事件给出的列头位置放一个透明的定位块，Tooltip 挂在它上面。

import type { GridMouseEventArgs, Rectangle } from '@glideapps/glide-data-grid'
import { Tooltip } from 'antd'
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'

import type { ColumnMeta } from '../../shared/exec'

/** 列名（小写）→ 注释。 */
export type ColumnComments = ReadonlyMap<string, string>

/** 按列名找注释，不分大小写（Oracle、达梦返回大写列名）。 */
export function commentOf(comments: ColumnComments | undefined, column: string): string | undefined {
  return comments?.get(column.toLowerCase())
}

/** 由列名和注释建表：去掉空注释；同名列注释不同（如连接查询的两张表）时不显示，免得张冠李戴。 */
export function buildComments(columns: Iterable<{ name: string; comment?: string | null }>): Map<string, string> {
  const out = new Map<string, string>()
  const conflict = new Set<string>()
  for (const c of columns) {
    const key = c.name.toLowerCase()
    const text = c.comment?.trim()
    if (!text || conflict.has(key)) continue
    const seen = out.get(key)
    if (seen !== undefined && seen !== text) {
      out.delete(key)
      conflict.add(key)
    } else out.set(key, text)
  }
  return out
}

const DELAY_MS = 400

export function useHeaderComment(
  columns: readonly ColumnMeta[],
  comments: ColumnComments | undefined,
): { onItemHovered: (args: GridMouseEventArgs) => void; tip: ReactNode } {
  const [tip, setTip] = useState<{ text: string; rect: Rectangle } | null>(null)
  const timer = useRef<number | undefined>(undefined)
  useEffect(() => () => window.clearTimeout(timer.current), [])
  const onItemHovered = useCallback(
    (args: GridMouseEventArgs) => {
      window.clearTimeout(timer.current)
      const name = args.kind === 'header' ? columns[args.location[0]]?.name : undefined
      const text = name === undefined ? undefined : commentOf(comments, name)
      if (!text || args.kind !== 'header') {
        setTip(null)
        return
      }
      const rect = args.bounds
      timer.current = window.setTimeout(() => setTip({ text, rect }), DELAY_MS)
    },
    [columns, comments],
  )
  const node = tip && (
    <Tooltip open title={tip.text} placement="top">
      <span
        style={{
          position: 'fixed',
          left: tip.rect.x,
          top: tip.rect.y,
          width: tip.rect.width,
          height: tip.rect.height,
          pointerEvents: 'none',
        }}
      />
    </Tooltip>
  )
  return { onItemHovered, tip: node }
}
