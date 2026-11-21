// 结果里看到的 SQL（如运维页慢 SQL 的语句列）交给 AI 优化：查询标签页提供，单元格查看框使用。

import { createContext, useContext } from 'react'

export const AiSqlContext = createContext<((sql: string) => void) | null>(null)

export function useAiSql() {
  return useContext(AiSqlContext)
}

/** 看起来像一条 SQL 语句（单元格内容）。 */
export function looksLikeSql(text: string): boolean {
  return /^\s*(select|with|insert|update|delete|merge)\b/i.test(text) && text.length < 100_000
}
