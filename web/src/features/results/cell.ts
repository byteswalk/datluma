// 单元格查看（设计稿第 3 部分）：文本、JSON、十六进制三种显示。纯函数，单独测试。

import { type CellValue, cellText } from '../../shared/exec'
import { t } from '../../shared/i18n'

interface LobPreview {
  preview: string
  total_len: number
  truncated: boolean
  binary: boolean
}

/** 文本视图：字符串和大字段显示完整的预览内容，其他值同表格。 */
export function cellFullText(c: CellValue): string {
  if (c.t === 'lob') return (c.v as LobPreview).preview
  if (c.t === 'string') return String(c.v)
  return cellText(c)
}

/** 大字段的说明：总长度，以及是否只取了预览。 */
export function lobNote(c: CellValue): string | null {
  if (c.t !== 'lob') return null
  const v = c.v as LobPreview
  const size = formatBytes(v.total_len)
  return v.truncated ? t('results.cell.truncated', { size }) : size
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** JSON 视图：能解析成对象或数组时缩进显示，否则为 null（不提供这个视图）。 */
export function prettyJson(c: CellValue): string | null {
  if (c.t === 'json') return JSON.stringify(c.v, null, 2)
  const text = cellFullText(c).trim()
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return null
  }
}

/** 单元格的字节：二进制值按 base64 解码，其他按 UTF-8 编码显示文本。 */
export function cellBytes(c: CellValue): Uint8Array {
  if (c.t === 'bytes' && typeof c.v === 'string') return Uint8Array.from(atob(c.v), (ch) => ch.charCodeAt(0))
  return new TextEncoder().encode(cellFullText(c))
}

/** 十六进制视图：每行 16 字节，偏移、十六进制、可打印字符。最多显示 `max` 字节。 */
export function hexDump(bytes: Uint8Array, max = 64 * 1024): string {
  const lines: string[] = []
  const n = Math.min(bytes.length, max)
  for (let off = 0; off < n; off += 16) {
    const chunk = Array.from(bytes.subarray(off, Math.min(off + 16, n)))
    const hex = chunk.map((b) => b.toString(16).padStart(2, '0')).join(' ')
    const ascii = chunk.map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.')).join('')
    lines.push(`${off.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  |${ascii}|`)
  }
  if (bytes.length > max) lines.push(t('results.cell.hexMore', { total: bytes.length, max }))
  return lines.join('\n')
}

/** 数值类型右对齐。 */
export function isNumeric(c: CellValue): boolean {
  return c.t === 'int' || c.t === 'u_int' || c.t === 'float' || c.t === 'decimal'
}

/** 各库数值列的类型名（去掉长度、精度后比较）。interval、日期等不算。 */
const NUMERIC_TYPE =
  /^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial|smallserial|decimal|dec|numeric|number|real|float|float4|float8|double|double precision|binary_float|binary_double|money|smallmoney|bit_integer|pls_integer|unsigned)\b/

/**
 * 整列是不是数值列，决定表头靠右还是靠左（和下面的数字对齐）。先看列的类型名；类型名为空（如 SQLite 的表达式列）时，
 * 看已加载的值：有非空值且非空值都是数值才算。只看列类型，整列 NULL 时表头不会忽左忽右。
 */
export function isNumericColumn(typeName: string, values: CellValue[]): boolean {
  const name = typeName.trim().toLowerCase()
  if (name) return NUMERIC_TYPE.test(name)
  const filled = values.filter((v) => v.t !== 'null')
  return filled.length > 0 && filled.every(isNumeric)
}
