import { describe, expect, it } from 'vitest'

import { mysql } from './mysql'
import { postgres } from './postgres'

// 结果列注释（results/statementComments）把光标放在语句末尾，取语句里用到的表
describe('语句末尾取用到的表', () => {
  it('单表、表达式列、连接查询的表都能取到', () => {
    for (const p of [postgres, mysql]) {
      const sql = 'select model_no, amount * 2 as doubled from dblens_tip_demo'
      expect(p.suggest(sql, sql.length).tables.map((t) => t.name)).toEqual(['dblens_tip_demo'])
      const join = 'select a.x, b.y from t1 a join t2 b on a.id = b.id where a.x > 1'
      expect(p.suggest(join, join.length).tables.map((t) => t.name)).toEqual(['t1', 't2'])
    }
  })
})
