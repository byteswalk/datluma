// 查询结果的列注释：解析器找出语句里用到的表，再从补全用的元数据缓存里取这些表的列注释。
// 结果列按名称对上注释；别名、表达式列对不上就不显示。同名列注释不同（连接查询）时也不显示，见 buildComments。

import { findName } from '../sql/metadata'
import { lightSuggest } from '../sql/completion'
import { sqlDialect } from '../sql/dialects'
import type { EditorSqlContext } from '../sql/provider'
import { sqlClient } from '../sql/service'
import { buildComments } from './headerComment'

export async function statementComments(text: string, ctx: EditorSqlContext): Promise<Map<string, string>> {
  const { dialect } = sqlDialect(ctx.driver, ctx.variant, ctx.compat)
  // 解析器不可用或超时：退回轻量分析（和补全相同）
  const r = sqlClient.unavailable(dialect) ? null : await sqlClient.suggest(dialect, text, text.length)
  const tables = (r?.ok ? r.value : lightSuggest(text, text.length)).tables
  if (tables.length === 0) return new Map()
  const schemas = await ctx.meta.schemas()
  const columns: { name: string; comment?: string | null }[] = []
  for (const ref of tables) {
    const schema = ref.schema === undefined ? ctx.schema : (findName(schemas, ref.schema) ?? ref.schema)
    if (!schema) continue
    const obj = findName(await ctx.meta.objects(schema), ref.name)
    columns.push(...(await ctx.meta.columns(schema, obj?.name ?? ref.name)))
  }
  return buildComments(columns)
}
