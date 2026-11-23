import { describe, expect, it } from 'vitest'

import { joinCatalog } from '../../shared/api'
import type { QueryTab } from '../editor/tabs'
import { revealTargetOf, takeReveal, useReveal } from './reveal'

const tab = (x: Partial<QueryTab>): QueryTab => ({ id: 't', title: 'T', profileId: 'p1', sql: '', ...x })

describe('revealTargetOf', () => {
  it('查询标签到会话的当前 schema，没连上时只到连接', () => {
    expect(revealTargetOf(tab({}), 'postgres', 'public')).toEqual({ panel: 'db', profileId: 'p1', schema: 'public' })
    expect(revealTargetOf(tab({}), 'postgres', null)).toEqual({ panel: 'db', profileId: 'p1' })
  })

  it('SQL Server 的查询标签到当前库', () => {
    expect(revealTargetOf(tab({}), 'sqlserver', 'sales')).toEqual({ panel: 'db', profileId: 'p1', catalog: 'sales' })
  })

  it('数据标签到对象本身，按对象类型找分类', () => {
    const r = revealTargetOf(tab({ data: { schema: 's', object: 'v1', objectKind: 'view' } }), 'mysql')
    expect(r).toEqual({ panel: 'db', profileId: 'p1', schema: 's', object: { kinds: ['views'], name: 'v1' } })
  })

  it('表设计器：已有表到表，新建表到 schema', () => {
    expect(revealTargetOf(tab({ design: { schema: 's', table: 'a' } }), 'mysql')).toMatchObject({ object: { name: 'a' } })
    expect(revealTargetOf(tab({ design: { schema: 's', table: null } }), 'mysql')).toEqual({ panel: 'db', profileId: 'p1', schema: 's' })
  })

  it('模型设计器和模型 ER 图到模型面板', () => {
    expect(revealTargetOf(tab({ profileId: '', design: { schema: 's', table: 'a', model: 'D:/m' } }), undefined)).toEqual({
      panel: 'models', model: 'D:/m', schema: 's', table: 'a',
    })
    expect(revealTargetOf(tab({ profileId: '', er: { kind: 'model', path: 'D:/m', schema: 's', diagram: 'main' } }), undefined)).toEqual({
      panel: 'models', model: 'D:/m', schema: 's',
    })
  })

  it('比对：有库的一边优先，两边都是模型时到模型面板', () => {
    const db = { kind: 'database' as const, profile: 'p2', schema: joinCatalog('c', 'dbo') }
    const model = { kind: 'model' as const, path: 'D:/m', schema: 's' }
    expect(revealTargetOf(tab({ profileId: '', compare: { source: model, target: db } }), undefined)).toEqual({
      panel: 'db', profileId: 'p2', schema: db.schema,
    })
    expect(revealTargetOf(tab({ profileId: '', compare: { source: model, target: null } }), undefined)).toMatchObject({ panel: 'models' })
  })

  it('权限页有焦点时到对象，表和视图都找', () => {
    const r = revealTargetOf(tab({ privileges: { focus: { schema: 's', object: 'o' } } }), 'postgres')
    expect(r).toMatchObject({ object: { kinds: ['tables', 'views', 'materialized_views'], name: 'o' } })
    expect(revealTargetOf(tab({ privileges: {} }), 'postgres')).toEqual({ panel: 'db', profileId: 'p1' })
  })

  it('定位不了时给原因', () => {
    expect(revealTargetOf(tab({}), undefined, 'x')).toEqual({ reason: 'profileDeleted' })
    expect(revealTargetOf(tab({ profileId: '' }), undefined)).toEqual({ reason: 'noProfile' })
    expect(revealTargetOf(tab({ profileId: '', lint: { view: 'library' } }), undefined)).toEqual({ reason: 'lintLibrary' })
  })
})

describe('takeReveal', () => {
  it('每个请求只给对应面板取一次', () => {
    useReveal.getState().reveal({ panel: 'db', profileId: 'p1' })
    expect(takeReveal('models')).toBeUndefined()
    expect(takeReveal('db')).toEqual({ panel: 'db', profileId: 'p1' })
    expect(takeReveal('db')).toBeUndefined()
    useReveal.getState().reveal({ panel: 'db', profileId: 'p1' })
    expect(takeReveal('db')).toBeDefined()
  })
})
