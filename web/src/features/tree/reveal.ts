// "在对象树中定位"：按当前标签算出要定位的节点，交给对象树（或模型面板）逐层展开、选中并滚动到可见处。
// 目标的算法是纯函数，单独测试；定位请求放在一个小 store 里，侧栏标题上的准星按钮发出，树组件收到后执行。

import { create } from 'zustand'

import type { DriverId, TargetKind } from '../../shared/api'
import { hasCatalogs } from '../../shared/schemaOptions'
import type { QueryTab } from '../editor/tabs'
import type { CategoryKind } from './nodes'

/**
 * 要定位到的位置。
 * - 对象树：`schema` 是合成值（SQL Server 含库，见 api.ts 的 joinCatalog）；只到库时给 `catalog`。
 *   `object.kinds` 是可能所在的分类，按顺序找（权限页只知道对象名，不知道是表还是视图）。
 * - 模型面板：`model` 是模型目录。
 */
export type RevealTarget =
  | { panel: 'db'; profileId: string; catalog?: string; schema?: string; object?: { kinds: CategoryKind[]; name: string } }
  | { panel: 'models'; model: string; schema?: string; table?: string }

/** 定位不了时的原因（词条键）。 */
export type RevealMiss = { reason: 'noProfile' | 'profileDeleted' | 'lintLibrary' }

const KIND_OF: Record<TargetKind, CategoryKind> = { table: 'tables', view: 'views', materialized_view: 'materialized_views' }
const TABLE_LIKE: CategoryKind[] = ['tables', 'views', 'materialized_views']

/**
 * 按标签算定位目标。`driver` 是标签所连连接的驱动（连接已删除时为空），`sessionSchema` 是查询标签会话的当前 schema
 * （SQL Server 是当前库）。规范检查结果要先查运行记录才知道检查的是哪里，由调用方处理。
 */
export function revealTargetOf(
  tab: QueryTab,
  driver: DriverId | undefined,
  sessionSchema?: string | null,
): RevealTarget | RevealMiss {
  // 模型：设计器、模型的 ER 图、两边都是模型的比对
  if (tab.design?.model) {
    return { panel: 'models', model: tab.design.model, schema: tab.design.schema, table: tab.design.table ?? undefined }
  }
  if (tab.er?.kind === 'model') return { panel: 'models', model: tab.er.path, schema: tab.er.schema }
  if (tab.compare) {
    const side = [tab.compare.source, tab.compare.target].find((s) => s?.kind === 'database') ?? tab.compare.source
    if (side?.kind === 'database') return { panel: 'db', profileId: side.profile, schema: side.schema }
    if (side?.kind === 'model') return { panel: 'models', model: side.path, schema: side.schema }
    return { reason: 'noProfile' }
  }
  if (tab.migrate) return { panel: 'db', profileId: tab.migrate.source.profile, schema: tab.migrate.source.schema }
  if (tab.lint) return { reason: tab.lint.view === 'library' ? 'lintLibrary' : 'noProfile' }

  if (!tab.profileId) return { reason: 'noProfile' }
  if (!driver) return { reason: 'profileDeleted' }
  const profileId = tab.profileId
  if (tab.er?.kind === 'database') return { panel: 'db', profileId, schema: tab.er.schema }
  if (tab.data) {
    return { panel: 'db', profileId, schema: tab.data.schema, object: { kinds: [KIND_OF[tab.data.objectKind]], name: tab.data.object } }
  }
  if (tab.design) {
    return tab.design.table
      ? { panel: 'db', profileId, schema: tab.design.schema, object: { kinds: ['tables'], name: tab.design.table } }
      : { panel: 'db', profileId, schema: tab.design.schema }
  }
  if (tab.privileges) {
    const f = tab.privileges.focus
    return f ? { panel: 'db', profileId, schema: f.schema, object: { kinds: TABLE_LIKE, name: f.object } } : { panel: 'db', profileId }
  }
  // 查询标签：会话的当前 schema；SQL Server 的当前 schema 是库；还没连上时只到连接
  if (!sessionSchema) return { panel: 'db', profileId }
  return hasCatalogs(driver) ? { panel: 'db', profileId, catalog: sessionSchema } : { panel: 'db', profileId, schema: sessionSchema }
}

export function isMiss(x: RevealTarget | RevealMiss): x is RevealMiss {
  return 'reason' in x
}

interface RevealState {
  /** 待执行的定位；`seq` 每次加一，同一个目标连点两次也会再定位。 */
  request: { target: RevealTarget; seq: number } | null
  reveal(target: RevealTarget): void
}

export const useReveal = create<RevealState>((set, get) => ({
  request: null,
  reveal: (target) => set({ request: { target, seq: (get().request?.seq ?? 0) + 1 } }),
}))

let handled = 0

/** 取出给这个面板的、还没处理的定位请求（取出即算处理过，组件重新挂载不会再执行一次）。 */
export function takeReveal(panel: RevealTarget['panel']): RevealTarget | undefined {
  const r = useReveal.getState().request
  if (!r || r.seq <= handled || r.target.panel !== panel) return undefined
  handled = r.seq
  return r.target
}
