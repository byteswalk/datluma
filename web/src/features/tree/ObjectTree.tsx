// 数据库对象树（设计文档 7.3 节；M1 设计稿第 1、3 部分）：所有连接在一棵树里，可以同时展开多个。
// 懒加载：展开时向后端取下一层（后端有元数据缓存，"刷新"会先清后端缓存再重新取）。顶部过滤框按名称或注释过滤已加载的对象。
// 右键菜单（M1a）：连接 —— 编辑、复制、删除、刷新；其他节点 —— 复制名称、刷新。
// 对象节点另有（M1c2）："查看数据"（数据标签，也可双击打开）、"查看 DDL"（弹出只读预览）、
// "生成 SQL"（插入到当前编辑器）。
// SQL Server（M6a）：连接下先列库，库下是架构。

import { App, Dropdown, Input, type MenuProps, Tree } from 'antd'
import type { DataNode, EventDataNode } from 'antd/es/tree'
import {
  IconColumns,
  IconDatabase,
  IconEye,
  IconFolder,
  IconFunction,
  IconKey,
  IconLink,
  IconListNumbers,
  IconCheck,
  IconCube,
  IconCylinder,
  IconServer2,
  IconUser,
  IconUsers,
  IconSearch,
  IconStack2,
  IconTable,
} from '@tabler/icons-react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { type Key, type ReactNode, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useHost, withoutHidden } from '../../shared/host'

import { useApi } from '../../app/context'
import { useUi } from '../../app/ui'
import { useQueryActions } from '../editor/actions'
import { tabsInSchemas, tabsOfTable, useTabs } from '../editor/tabs'
import { useExportDialog } from '../export/dialog'
import { useImportDialogs } from '../import/dialog'
import { useDocExport } from '../document/dialog'
import { useLintStart } from '../lint/dialog'
import { emptyPlan } from '../migrate/plan'
import { useModelDialogs } from '../model/dialogs'
import {
  type Api,
  type Environment,
  type NamespaceCaps,
  type NamespaceChange,
  type Profile,
  type RoutineInfo,
  exportSource,
  joinCatalog,
  schemaLabel,
  splitCatalog,
} from '../../shared/api'
import DbIcon from '../../shared/DbIcon'
import { hasCatalogs } from '../../shared/schemaOptions'
import EnvTag from '../../shared/EnvTag'
import { isLoopback, profileKind } from '../connections/form'
import { withVault } from '../connections/vault'
import { isSchemaField } from '../connections/DatabaseInput'
import { NamespaceDialog, PrincipalDialog } from './ServerDialogs'
import { hasServerObjects, hasTablespaces, namespaceCaps, tablespaceExtra } from './serverObjects'
import { metaKey } from '../sql/metadata'
import ConnName, { connHost, connKind } from './ConnName'
import EnvFilter, { ALL_ENVS } from './EnvFilter'
import type { DdlTarget } from './DdlDialog'
import {
  type CategoryKind,
  type NodeKey,
  type ServerFolder,
  categoriesFor,
  categoryLabel,
  decodeKey,
  encodeKey,
  hasObject,
  isWithin,
  matches,
  qualifiedName,
  routineKindLabel,
} from './nodes'
import { ddlKind, generateChoice, generateMenu, targetKind } from './objectMenu'
import { type RevealTarget, takeReveal, useReveal } from './reveal'

// 预览用 Monaco：和工作区一样先加载它的语言包，第一次查看 DDL 时才加载
const DdlDialog = lazy(async () => {
  const { loadMonacoLocale } = await import('../editor/monacoLocale')
  await loadMonacoLocale()
  return import('./DdlDialog')
})

/**
 * 已加载的一层子节点。`items` 中的 key 为编码后的节点键。
 * 分类、系统分组的名称和程序类型在显示时按当前界面语言翻译，切换语言后不必重新加载。
 */
interface Loaded {
  items: {
    key: string
    label: string
    comment?: string | null
    extra?: string
    routineKind?: RoutineInfo['kind']
    leaf: boolean
    pk?: boolean
  }[]
  error?: string
}

const CATEGORY_ICON: Record<CategoryKind, ReactNode> = {
  tables: <IconTable size={16} className="ic-table" />,
  views: <IconEye size={16} className="ic-view" />,
  materialized_views: <IconStack2 size={16} className="ic-mview" />,
  routines: <IconFunction size={16} className="ic-routine" />,
  sequences: <IconListNumbers size={16} className="ic-sequence" />,
  synonyms: <IconLink size={16} className="ic-synonym" />,
}

/** 按节点键取下一层。 */
async function loadChildren(api: Api, profiles: Profile[], k: NodeKey): Promise<Loaded['items']> {
  switch (k.type) {
    case 'c':
    case 'd':
    case 'g': {
      const profile = profiles.find((p) => p.id === k.profileId)
      const driver = profile?.driver
      // SQL Server：连接下是库，库下才是架构；master、msdb 等系统库不进树
      // 连接下最后是"服务器对象"（用户、角色、表空间），SQLite 没有
      const server: Loaded['items'] =
        k.type === 'c' && hasServerObjects(driver)
          ? [{ key: encodeKey({ type: 'v', profileId: k.profileId }), label: '', leaf: false }]
          : []
      if (k.type === 'c' && driver && hasCatalogs(driver)) {
        const dbs = (await api.catalogs(k.profileId))
          .filter((c) => !c.is_system)
          .map((c) => ({
            key: encodeKey({ type: 'd', profileId: k.profileId, catalog: c.name }),
            label: c.name,
            leaf: false,
          }))
        return [...dbs, ...server]
      }
      const catalog = k.type === 'd' || k.type === 'g' ? k.catalog : undefined
      const schemas = await api.schemas(k.profileId, undefined, catalog)
      // 系统模式不进树（要查系统视图就写语句）；达梦等连接填了模式时只显示这一个模式（不分大小写）
      const only = k.type === 'c' && profile && isSchemaField(profile) ? profile.database?.trim().toLowerCase() : undefined
      const pick = only ? schemas.filter((s) => s.name.toLowerCase() === only) : schemas.filter((s) => !s.is_system)
      const items: Loaded['items'] = pick.map((s) => ({
        key: encodeKey({ type: 's', profileId: k.profileId, schema: catalog === undefined ? s.name : joinCatalog(catalog, s.name) }),
        label: s.name,
        leaf: false,
      }))
      return [...items, ...server]
    }
    case 'v': {
      const driver = profiles.find((p) => p.id === k.profileId)?.driver
      const { caps } = await api.privilegeOverview(k.profileId)
      const folders: ServerFolder[] = [
        'users',
        ...(caps.roles ? (['roles'] as const) : []),
        ...(hasTablespaces(driver) ? (['tablespaces'] as const) : []),
      ]
      return folders.map((folder) => ({ key: encodeKey({ type: 'f', profileId: k.profileId, folder }), label: '', leaf: false }))
    }
    case 'f': {
      if (k.folder === 'tablespaces') {
        return (await api.tablespaces(k.profileId)).map((ts) => ({
          key: encodeKey({ type: 't', profileId: k.profileId, name: ts.name }),
          label: ts.name,
          extra: tablespaceExtra(ts),
          leaf: true,
        }))
      }
      // 内置的系统用户、角色不列（和系统模式一样）
      const kind = k.folder === 'users' ? 'user' : 'role'
      return (await api.privilegeOverview(k.profileId)).principals
        .filter((p) => p.kind === kind && !p.builtin)
        .map((p) => ({
          key: encodeKey({ type: 'p', profileId: k.profileId, kind, id: p.id }),
          label: p.host ? `${p.name}@${p.host}` : p.name,
          leaf: true,
        }))
    }
    case 's': {
      const driver = profiles.find((p) => p.id === k.profileId)?.driver ?? 'mysql'
      return categoriesFor(driver).map((c) => ({
        key: encodeKey({ type: 'k', profileId: k.profileId, schema: k.schema, kind: c.kind }),
        label: c.label,
        leaf: false,
      }))
    }
    case 'k': {
      const obj = (name: string, comment: string | null, extra?: string, routineKind?: RoutineInfo['kind']) => ({
        key: encodeKey({ type: 'o', profileId: k.profileId, schema: k.schema, kind: k.kind, name, routineKind }),
        label: name,
        comment,
        extra,
        routineKind,
        leaf: k.kind !== 'tables',
      })
      if (k.kind === 'tables' || k.kind === 'views' || k.kind === 'materialized_views') {
        return (await api.objects(k.profileId, k.schema, k.kind)).map((o) => obj(o.name, o.comment))
      }
      if (k.kind === 'routines') {
        return (await api.routines(k.profileId, k.schema)).map((r) => obj(r.name, null, undefined, r.kind))
      }
      if (k.kind === 'sequences') return (await api.sequences(k.profileId, k.schema)).map((s) => obj(s.name, null))
      return (await api.synonyms(k.profileId, k.schema)).map((s) =>
        obj(s.name, null, `→ ${s.target_schema ? `${s.target_schema}.` : ''}${s.target_name}${s.db_link ? `@${s.db_link}` : ''}`),
      )
    }
    case 'o': {
      const t = await api.table(k.profileId, k.schema, k.name)
      const pk = new Set(t?.primary_key?.columns ?? [])
      return (t?.columns ?? []).map((c) => ({
        key: encodeKey({ type: 'l', profileId: k.profileId, schema: k.schema, table: k.name, column: c.name }),
        label: c.name,
        comment: c.comment,
        extra: `${c.data_type.native}${c.nullable ? '' : ' not null'}`,
        leaf: true,
        pk: pk.has(c.name),
      }))
    }
    case 'l':
    case 'p':
    case 't':
      return []
  }
}

export default function ObjectTree() {
  const api = useApi()
  const qc = useQueryClient()
  const { t } = useTranslation()
  const { message, modal } = App.useApp()
  const { openConnection, selectProfile } = useUi()
  const { hidden } = useHost()
  const { newQuery, insertSql } = useQueryActions()
  const { data: profiles = [], error: profilesError } = useQuery({ queryKey: ['profiles'], queryFn: () => api.profiles() })
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({})
  const [expanded, setExpanded] = useState<Key[]>([])
  const [filter, setFilter] = useState('')
  const [envs, setEnvs] = useState<Environment[]>(ALL_ENVS)
  const [selected, setSelected] = useState<Key[]>([])
  const [menuNode, setMenuNode] = useState<NodeKey | null>(null)
  const [ddl, setDdl] = useState<DdlTarget | null>(null)
  // 新建、删除库或模式：`after` 是完成后要刷新的节点，`inside` 判断标签页里的 schema 是否在被删的库或模式里
  const [nsDialog, setNsDialog] = useState<{
    profileId: string
    catalog?: string
    caps: NamespaceCaps
    create?: 'database' | 'schema'
    drop?: NamespaceChange
    after: NodeKey
    inside?: (schema: string) => boolean
  } | null>(null)
  const [principalDialog, setPrincipalDialog] = useState<{
    profileId: string
    action: { kind: 'create-user' | 'create-role' } | { kind: 'drop'; principalId: string }
  } | null>(null)

  // 右键表时取它的外键关系，组装"关联查询"子菜单；取不到时当作没有外键
  const relTable = menuNode?.type === 'o' && menuNode.kind === 'tables' ? menuNode : null
  const { data: relationsData, error: relationsError } = useQuery({
    queryKey: ['relations', relTable?.profileId, relTable?.schema, relTable?.name],
    queryFn: () => api.relations(relTable!.profileId, relTable!.schema, relTable!.name),
    enabled: !!relTable,
    retry: false,
    staleTime: 30_000,
  })
  const relations = relationsError ? [] : relationsData

  const load = useCallback(
    async (key: string) => {
      const k = decodeKey(key)
      let result: Loaded
      try {
        const items = await withVault(api, () => loadChildren(api, profiles, k))
        result = { items }
        // 第一次连上时后端记下了识别出的数据库变体：重新取连接列表，换成具体数据库的图标
        if (k.type === 'c' && !profiles.find((p) => p.id === k.profileId)?.variant) {
          void qc.invalidateQueries({ queryKey: ['profiles'] })
        }
      } catch (e) {
        result = { items: [], error: (e as Error).message }
      }
      setLoaded((m) => ({ ...m, [key]: result }))
      return result
    },
    [api, profiles, qc],
  )

  // 定位时逐层等加载：已加载的直接用
  const loadedRef = useRef(loaded)
  loadedRef.current = loaded
  const ensure = async (key: string) => loadedRef.current[key] ?? (await load(key))
  const treeBox = useRef<HTMLDivElement>(null)

  /** 在树中定位：清掉过滤，逐层加载并展开到目标，选中它并滚到可见处。找不到的层停在上一层。 */
  const reveal = async (target: Extract<RevealTarget, { panel: 'db' }>) => {
    if (filter.trim() || envs.length !== ALL_ENVS.length) {
      setFilter('')
      setEnvs(ALL_ENVS)
      message.info(t('tree.reveal.cleared'))
    }
    const { profileId } = target
    const driver = driverOf(profileId)
    const conn = encodeKey({ type: 'c', profileId })
    const path: string[] = []
    let at = conn
    // 在一层子节点里找：先精确匹配，再忽略大小写
    const find = async (parent: string, want: string, keyOf: (k: NodeKey) => string | undefined) => {
      const l = await ensure(parent)
      const hit = (eq: (a: string) => boolean) => l.items.find((i) => {
        const v = keyOf(decodeKey(i.key))
        return v !== undefined && eq(v)
      })?.key
      return hit((a) => a === want) ?? hit((a) => a.toLowerCase() === want.toLowerCase())
    }
    const catalog = target.catalog ?? (driver && hasCatalogs(driver) && target.schema ? splitCatalog(target.schema).catalog : undefined)
    let missing: string | undefined
    if (catalog !== undefined) {
      const d = await find(at, catalog, (k) => (k.type === 'd' ? k.catalog : undefined))
      if (d) {
        path.push(at)
        at = d
      } else missing = catalog
    }
    if (!missing && target.schema) {
      const want = target.schema
      const schemaOf = (k: NodeKey) => (k.type === 's' ? k.schema : undefined)
      const s = await find(at, want, schemaOf)
      if (s) {
        path.push(at)
        at = s
      } else missing = splitCatalog(want).schema
    }
    if (!missing && target.object) {
      const schema = (decodeKey(at) as Extract<NodeKey, { type: 's' }>).schema
      let found: string | undefined
      for (const kind of target.object.kinds) {
        const k = encodeKey({ type: 'k', profileId, schema, kind })
        if (!(await ensure(at)).items.some((i) => i.key === k)) continue
        found = await find(k, target.object.name, (x) => (x.type === 'o' ? x.name : undefined))
        if (found) {
          path.push(at, k)
          at = found
          break
        }
      }
      if (!found) missing = target.object.name
    }
    if (missing) message.info(t('tree.reveal.notFound', { name: missing }))
    setExpanded((e) => [...new Set([...e.map(String), ...path])])
    setSelected([at])
    selectProfile(profileId)
    // 等展开的节点渲染出来再滚动
    setTimeout(() => treeBox.current?.querySelector('.ant-tree-treenode-selected')?.scrollIntoView({ block: 'nearest' }), 60)
  }

  const revealRequest = useReveal((s) => s.request)
  useEffect(() => {
    // 侧栏刚切过来时连接列表可能还没取到；已处理过的请求不再执行（切换侧栏后组件会重新挂载）
    if (!profiles.length) return
    const target = takeReveal('db')
    if (target?.panel === 'db') void reveal(target)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequest, profiles])

  /** 刷新一个节点：清后端元数据缓存，丢掉它下面已加载和已展开的内容，再重新取。系统分组按所在的连接或库刷新。 */
  const refresh = async (node: NodeKey) => {
    const k: NodeKey =
      node.type === 'g'
        ? node.catalog === undefined
          ? { type: 'c', profileId: node.profileId }
          : { type: 'd', profileId: node.profileId, catalog: node.catalog }
        : node
    const key = encodeKey(k)
    await api.refresh(k.profileId, 'schema' in k ? k.schema : null).catch(() => {})
    // 补全用的元数据一并失效
    void qc.invalidateQueries({ queryKey: metaKey(k.profileId, 'schema' in k ? k.schema : undefined) })
    const under = (x: string) => isWithin(decodeKey(x), k)
    setLoaded((m) => Object.fromEntries(Object.entries(m).filter(([x]) => x !== key && !under(x))))
    setExpanded((e) => e.filter((x) => !under(String(x))))
    if (k.type === 'c') await qc.invalidateQueries({ queryKey: ['profiles'] })
    await load(key)
  }

  // 导入建了表、执行了 SQL 文件：刷新对应的 schema（没有展开过的不用刷新）
  const treeRefresh = useUi((s) => s.treeRefresh)
  useEffect(() => {
    if (!treeRefresh) return
    const { profileId, schema } = treeRefresh
    const node: NodeKey = schema ? { type: 's', profileId, schema } : { type: 'c', profileId }
    if (loaded[encodeKey(node)]) void refresh(node)
    // 只在收到新的刷新请求时执行
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [treeRefresh])

  const treeData = useMemo<DataNode[]>(() => {
    // filterObjects：按过滤词筛已加载的对象（表、视图……）；连接本身匹配时不筛，显示它下面的全部内容
    const build = (parent: string, depth: number, filterObjects: boolean): DataNode[] | undefined => {
      const l = loaded[parent]
      if (!l) return undefined
      if (l.error) {
        return [{ key: `${parent}\u0002err`, isLeaf: true, selectable: false, title: <span className="err">{l.error}</span> }]
      }
      const items = l.items.filter((i) => {
        const type = decodeKey(i.key).type
        return !filterObjects || (type !== 'o' && type !== 'l') || matches(filter, i.label, i.comment)
      })
      return items.map((i) => {
        const k = decodeKey(i.key)
        const icon =
          k.type === 'v' ? <IconServer2 size={16} /> : k.type === 'f' ? <IconFolder size={16} /> : k.type === 'p' ? (k.kind === 'user' ? <IconUser size={16} /> : <IconUsers size={16} />) : k.type === 't' ? <IconCylinder size={16} /> : k.type === 'd' ? <IconDatabase size={16} /> : k.type === 's' ? <IconCube size={16} className="ic-schema" /> : k.type === 'g' ? <IconFolder size={16} /> : k.type === 'k' || k.type === 'o' ? CATEGORY_ICON[k.kind] : i.pk ? <IconKey size={16} color="var(--warn)" /> : <IconColumns size={16} />
        const label = k.type === 'k' ? categoryLabel(k.kind) : k.type === 'v' ? t('tree.server.title') : k.type === 'f' ? t(`tree.server.${k.folder}`) : k.type === 'g' ? t('tree.node.system') : i.label
        const extra = i.routineKind ? routineKindLabel(i.routineKind) : i.extra
        const count = (k.type === 'k' || k.type === 'f') && loaded[i.key] && !loaded[i.key].error ? loaded[i.key].items.length : null
        return {
          key: i.key,
          isLeaf: i.leaf,
          icon,
          title: (
            <span>
              {label}
              {count !== null && <span className="cm">{count}</span>}
              {extra && <span className="cm">{extra}</span>}
              {i.comment && <span className="cm">{i.comment}</span>}
            </span>
          ),
          children: build(i.key, depth + 1, filterObjects),
        }
      })
    }
    const text = filter.trim()
    // 过滤词先对连接（名称、地址、数据库类型）；连接不匹配时，看已展开的对象里有没有匹配的，有就保留连接、只显示匹配的对象
    return profiles.flatMap((p) => {
      const key = encodeKey({ type: 'c', profileId: p.id })
      const env = p.environment ?? 'none'
      if (!envs.includes(env)) return []
      const self = !text || matches(text, p.name, `${connHost(p)} ${connKind(p)}`)
      const children = build(key, 1, !self)
      if (!self && !hasObject(children)) return []
      return [{
        key,
        isLeaf: false,
        className: 'conn-node',
        title: (
          // 单行：连接名，环境标签靠右（各行对齐）。数据库类型和地址放在连接名的悬停提示里，
          // 没有主机的本地库按本机 127.0.0.1。名称过长时先省略
          <span className="conn-title">
            <DbIcon driver={p.driver} variant={profileKind(p).icon} />
            <ConnName profile={p} />
            <EnvTag env={env} />
          </span>
        ),
        children,
      }]
    })
  }, [profiles, loaded, filter, envs, t])

  const menuItems: MenuProps['items'] =
    menuNode?.type === 'c'
      ? [
          { key: 'new-query', label: t('tree.menu.newQuery'), extra: 'Ctrl+T' },
          { key: 'sql-file', label: t('tree.menu.sqlFile') },
          // SQLite 没有账号和权限
          ...(driverOf(menuNode.profileId) === 'sqlite' ? [] : [{ key: 'privileges', label: t('tree.menu.privileges') }]),
          ...createNamespaceItems(menuNode),
          { type: 'divider' },
          { key: 'edit', label: t('tree.menu.editConnection') },
          {
            key: 'env',
            label: t('tree.menu.environment'),
            // 当前环境打勾；选别的环境要二次确认
            children: (['none', 'dev', 'test', 'prod'] as Environment[]).map((e) => ({
              key: `env:${e}`,
              label: t(`connections.env.${e}`),
              // “本机”只给本机地址
              disabled: e === 'none' && !localAllowed(menuNode.profileId),
              icon: envOf(menuNode.profileId) === e ? <IconCheck size={14} /> : <span style={{ width: 14 }} />,
            })),
          },
          { key: 'duplicate', label: t('tree.menu.duplicateConnection') },
          { key: 'delete', label: t('tree.menu.deleteConnection'), danger: true },
          { type: 'divider' },
          { key: 'refresh', label: t('tree.menu.refresh') },
        ]
      : menuNode
        ? [
            ...createNamespaceItems(menuNode),
            ...serverItems(menuNode),
            ...schemaItems(menuNode),
            ...objectItems(menuNode),
            ...(qualifiedName(menuNode) ? [{ key: 'copy', label: t('tree.menu.copyName') }] : []),
            { key: 'refresh', label: t('tree.menu.refresh') },
            ...(menuNode.type === 'o' && menuNode.kind === 'tables'
              ? [{ type: 'divider' as const }, { key: 'drop-table', label: t('tree.menu.dropTable'), danger: true }]
              : []),
            ...dropNamespaceItems(menuNode),
            ...(menuNode.type === 'p'
              ? [{ type: 'divider' as const }, { key: 'srv:drop', label: t(menuNode.kind === 'user' ? 'tree.server.dropUser' : 'tree.server.dropRole'), danger: true }]
              : []),
          ]
        : []

  const shownItems = withoutHidden(
    menuItems ?? [],
    (i) => !hidden?.(`tree:${String(i?.key)}`),
    (i) => i?.type === 'divider',
  )

  function driverOf(profileId: string) {
    return profiles.find((p) => p.id === profileId)?.driver
  }

  function localAllowed(profileId: string): boolean {
    const p = profiles.find((x) => x.id === profileId)
    return !p || p.driver === 'sqlite' || isLoopback(p.host)
  }

  function envOf(profileId: string): Environment {
    return profiles.find((p) => p.id === profileId)?.environment ?? 'none'
  }

  /** 改连接的环境：二次确认，改成生产或从生产改掉时说明执行确认的变化。 */
  function changeEnvironment(profileId: string, to: Environment) {
    const p = profiles.find((x) => x.id === profileId)
    const from = envOf(profileId)
    if (!p || from === to) return
    const label = (e: Environment) => t(`connections.env.${e}`)
    const note = to === 'prod' ? t('tree.setEnv.toProd') : from === 'prod' ? t('tree.setEnv.fromProd') : ''
    modal.confirm({
      title: t('tree.setEnv.title', { name: p.name }),
      content: [t('tree.setEnv.content', { from: label(from), to: label(to) }), note].filter(Boolean).join(' '),
      okText: t('tree.setEnv.ok'),
      okType: to === 'prod' || from === 'prod' ? 'danger' : 'primary',
      onOk: async () => {
        const { id: _, ...input } = await api.profile(profileId)
        await api.updateProfile(profileId, { ...input, environment: to })
        await qc.invalidateQueries({ queryKey: ['profiles'] })
        message.success(t('tree.setEnv.done', { name: p.name, to: label(to) }))
      },
    })
  }

  /** 删除表：二次确认；生产环境还要输入表名。删除后刷新"表"分类。 */
  function dropTable(profileId: string, schema: string, name: string) {
    const prod = envOf(profileId) === 'prod'
    const full = `${schemaLabel(schema)}.${name}`
    const dialog = modal.confirm({
      title: t('tree.dropTable.title', { name: full }),
      content: (
        <div>
          <div>{t('tree.dropTable.content')}</div>
          {prod && (
            <div style={{ marginTop: 12 }}>
              <div style={{ marginBottom: 4 }}>{t('tree.dropTable.typeName', { name })}</div>
              <Input
                autoFocus
                onChange={(e) => dialog.update({ okButtonProps: { danger: true, disabled: e.target.value !== name } })}
              />
            </div>
          )}
        </div>
      ),
      okText: t('tree.dropTable.ok'),
      okType: 'danger',
      okButtonProps: { disabled: prod },
      onOk: async () => {
        try {
          await api.dropTable(profileId, schema, name)
        } catch (e) {
          message.error((e as Error).message)
          throw e
        }
        message.success(t('tree.dropTable.done', { name: full }))
        // 这张表的数据页、设计器页、权限定位页一并关掉；查询页不动
        const tabs = useTabs.getState()
        for (const x of tabsOfTable(tabs.tabs, profileId, schema, name)) tabs.close(x.id)
        await refresh({ type: 'k', profileId, schema, kind: 'tables' })
      },
    })
  }

  function nsCapsOf(profileId: string) {
    const p = profiles.find((x) => x.id === profileId)
    return namespaceCaps(p?.driver, p?.variant ?? p?.product)
  }

  /** 连接上新建库或模式；SQL Server 在连接上建库、在库上建架构。 */
  function createNamespaceItems(k: NodeKey): NonNullable<MenuProps['items']> {
    const caps = nsCapsOf(k.profileId)
    const sqlServer = driverOf(k.profileId) === 'sqlserver'
    if (k.type === 'c') {
      return [
        ...(caps.database ? [{ key: 'ns:create-database', label: t('tree.menu.newDatabase') }] : []),
        ...(caps.schema && !sqlServer ? [{ key: 'ns:create-schema', label: t('tree.menu.newSchema') }] : []),
      ]
    }
    if (k.type === 'd' && caps.schema) return [{ key: 'ns:create-schema', label: t('tree.menu.newSqlServerSchema') }, { type: 'divider' }]
    return []
  }

  /** 删除库或模式（放在菜单最后，红色）。MySQL 系的库就是模式。 */
  function dropNamespaceItems(k: NodeKey): NonNullable<MenuProps['items']> {
    const caps = nsCapsOf(k.profileId)
    const sqlServer = driverOf(k.profileId) === 'sqlserver'
    if (k.type === 'd' && caps.database) return [{ type: 'divider' }, { key: 'ns:drop-database', label: t('tree.menu.dropDatabase'), danger: true }]
    if (k.type !== 's') return []
    if (caps.database && !sqlServer) return [{ type: 'divider' }, { key: 'ns:drop-database', label: t('tree.menu.dropDatabase'), danger: true }]
    if (caps.schema) return [{ type: 'divider' }, { key: 'ns:drop-schema', label: t(sqlServer ? 'tree.menu.dropSqlServerSchema' : 'tree.menu.dropSchema'), danger: true }]
    return []
  }

  /** 服务器对象：用户、角色文件夹上新建，某个用户、角色上查看权限。 */
  function serverItems(k: NodeKey): NonNullable<MenuProps['items']> {
    if (k.type === 'f' && k.folder === 'users') return [{ key: 'srv:new-user', label: t('tree.server.newUser') }, { type: 'divider' }]
    if (k.type === 'f' && k.folder === 'roles') return [{ key: 'srv:new-role', label: t('tree.server.newRole') }, { type: 'divider' }]
    if (k.type === 'p') return [{ key: 'srv:open', label: t('tree.server.openPrivileges') }]
    return []
  }

  /** 打开新建、删除库或模式的对话框；完成后刷新上一级，删除时关掉里面对象的数据页、设计器页。 */
  function openNamespace(k: NodeKey, action: string) {
    const caps = nsCapsOf(k.profileId)
    const conn: NodeKey = { type: 'c', profileId: k.profileId }
    if (action === 'create-database') setNsDialog({ profileId: k.profileId, caps, create: 'database', after: conn })
    else if (action === 'create-schema' && k.type === 'd') setNsDialog({ profileId: k.profileId, catalog: k.catalog, caps, create: 'schema', after: k })
    else if (action === 'create-schema') setNsDialog({ profileId: k.profileId, caps, create: 'schema', after: conn })
    else if (action === 'drop-database' && k.type === 'd') {
      setNsDialog({ profileId: k.profileId, caps, drop: { op: 'drop_database', name: k.catalog }, after: conn, inside: (x) => splitCatalog(x).catalog === k.catalog })
    } else if (action === 'drop-database' && k.type === 's') {
      setNsDialog({ profileId: k.profileId, caps, drop: { op: 'drop_database', name: k.schema }, after: conn, inside: (x) => x === k.schema })
    } else if (action === 'drop-schema' && k.type === 's') {
      const { catalog, schema } = splitCatalog(k.schema)
      const after: NodeKey = catalog === undefined ? conn : { type: 'd', profileId: k.profileId, catalog }
      setNsDialog({ profileId: k.profileId, catalog, caps, drop: { op: 'drop_schema', name: schema }, after, inside: (x) => x === k.schema })
    }
  }

  /** schema 节点：新建表、导入到新表、执行 SQL 文件，后面接分隔线。 */
  function schemaItems(k: NodeKey): NonNullable<MenuProps['items']> {
    if (k.type !== 's') return []
    return [
      { key: 'new-table', label: t('tree.menu.newTable') },
      { key: 'import-new', label: t('tree.menu.importNew') },
      { key: 'sql-file', label: t('tree.menu.sqlFile') },
      { type: 'divider' },
      { key: 'er', label: t('tree.menu.er') },
      { key: 'compare-model', label: t('tree.menu.compareModel') },
      { key: 'save-model', label: t('tree.menu.saveAsModel') },
      { key: 'export-doc', label: t('tree.menu.exportDoc') },
      { key: 'lint', label: t('tree.menu.lint') },
      { key: 'migrate', label: t('tree.menu.migrate') },
      { type: 'divider' },
    ]
  }

  /** 对象节点的查看数据、设计表、导入导出、查看 DDL、生成 SQL，后面接分隔线；其他节点没有。 */
  function objectItems(k: NodeKey): NonNullable<MenuProps['items']> {
    if (k.type !== 'o') return []
    const items: NonNullable<MenuProps['items']> = []
    const target = targetKind(k.kind)
    if (target) items.push({ key: 'view-data', label: t('tree.menu.viewData') })
    if (target === 'table') items.push({ key: 'design', label: t('tree.menu.design') })
    if (target === 'table') items.push({ key: 'import', label: t('tree.menu.import') })
    if (target) items.push({ key: 'export-data', label: t('tree.menu.exportData') })
    if (ddlKind(k.kind, k.routineKind)) items.push({ key: 'ddl', label: t('tree.menu.viewDdl') })
    if (target) {
      // generateMenu 的项是 antd 菜单项的子集
      const children = generateMenu(target, relations) as NonNullable<MenuProps['items']>
      items.push({ key: 'gen-menu', label: t('tree.menu.generate'), children })
    }
    // SQLite 没有权限
    if (target && driverOf(k.profileId) !== 'sqlite') items.push({ key: 'who-can-access', label: t('tree.menu.whoCanAccess') })
    return items.length ? [...items, { type: 'divider' }] : []
  }

  /** 打开表、视图、物化视图的数据标签；其他节点不处理。 */
  const openData = (k: NodeKey) => {
    const objectKind = k.type === 'o' ? targetKind(k.kind) : null
    if (k.type === 'o' && objectKind) {
      useTabs.getState().openData(k.profileId, { schema: k.schema, object: k.name, objectKind })
    }
  }

  const onMenu = async (key: string) => {
    const k = menuNode
    if (!k) return
    try {
      const gen = k.type === 'o' ? generateChoice(key, relations) : null
      if (gen && k.type === 'o') {
        const sql = await api.generate(k.profileId, k.schema, {
          object: k.name,
          objectKind: targetKind(k.kind) ?? 'table',
          kind: gen.kind,
          ref: gen.relation && { schema: gen.relation.schema, table: gen.relation.table },
        })
        insertSql(sql, k.profileId)
      } else if (key === 'view-data') openData(k)
      else if (key === 'privileges') useTabs.getState().openPrivileges(k.profileId, t('privilege.title'))
      else if (key.startsWith('ns:')) openNamespace(k, key.slice(3))
      else if (key === 'srv:new-user') setPrincipalDialog({ profileId: k.profileId, action: { kind: 'create-user' } })
      else if (key === 'srv:new-role') setPrincipalDialog({ profileId: k.profileId, action: { kind: 'create-role' } })
      else if (key === 'srv:open' && k.type === 'p') useTabs.getState().openPrivileges(k.profileId, t('privilege.title'), undefined, k.id)
      else if (key === 'srv:drop' && k.type === 'p') setPrincipalDialog({ profileId: k.profileId, action: { kind: 'drop', principalId: k.id } })
      else if (key === 'who-can-access' && k.type === 'o') {
        useTabs.getState().openPrivileges(k.profileId, t('privilege.title'), { schema: k.schema, object: k.name })
      }
      else if (key === 'design' && k.type === 'o') useTabs.getState().openDesign(k.profileId, { schema: k.schema, table: k.name })
      else if (key === 'new-table' && k.type === 's') useTabs.getState().openDesign(k.profileId, { schema: k.schema, table: null })
      else if (key === 'er' && k.type === 's') {
        useTabs.getState().openEr({ kind: 'database', profile: k.profileId, schema: k.schema }, `${schemaLabel(k.schema)} · ER`)
      } else if (key === 'compare-model' && k.type === 's') {
        useTabs.getState().openCompare({ source: null, target: { kind: 'database', profile: k.profileId, schema: k.schema } })
      } else if (key === 'save-model' && k.type === 's') useModelDialogs.getState().openReverse({ profileId: k.profileId, schema: k.schema })
      else if (key === 'export-doc' && k.type === 's') useDocExport.getState().open({ kind: 'database', profile: k.profileId, schema: k.schema })
      else if (key === 'lint' && k.type === 's') useLintStart.getState().open({ kind: 'database', profile: k.profileId, schema: k.schema })
      else if (key === 'migrate' && k.type === 's') useTabs.getState().openMigrate(emptyPlan({ profile: k.profileId, schema: k.schema }))
      else if (key === 'import' && k.type === 'o') {
        useImportDialogs.getState().openImport({ profileId: k.profileId, schema: k.schema, table: k.name, create: false })
      } else if (key === 'import-new' && k.type === 's') {
        useImportDialogs.getState().openImport({ profileId: k.profileId, schema: k.schema, table: null, create: true })
      } else if (key === 'sql-file') {
        useImportDialogs.getState().openSqlFile({ profileId: k.profileId, schema: k.type === 's' ? k.schema : null })
      } else if (key === 'export-data' && k.type === 'o') {
        useExportDialog.getState().open({
          profileId: k.profileId,
          source: exportSource(k.schema, k.name),
          baseName: k.name,
          table: `${schemaLabel(k.schema)}.${k.name}`,
          inTransaction: false,
        })
      }
      else if (key === 'ddl' && k.type === 'o') {
        const kind = ddlKind(k.kind, k.routineKind)
        const driver = profiles.find((p) => p.id === k.profileId)?.driver
        if (kind && driver) setDdl({ profileId: k.profileId, driver, schema: k.schema, kind, name: k.name })
      } else if (key === 'new-query') newQuery(k.profileId)
      else if (key === 'edit' && k.type === 'c') openConnection(k.profileId)
      else if (key.startsWith('env:') && k.type === 'c') changeEnvironment(k.profileId, key.slice(4) as Environment)
      else if (key === 'duplicate' && k.type === 'c') {
        const p = await api.profile(k.profileId)
        const { id: _, ...input } = p
        await api.createProfile({ ...input, name: t('tree.duplicate.name', { name: p.name }) }, null)
        await qc.invalidateQueries({ queryKey: ['profiles'] })
        message.success(t('tree.duplicate.done'))
      } else if (key === 'delete' && k.type === 'c') {
        const p = profiles.find((x) => x.id === k.profileId)
        modal.confirm({
          title: t('tree.delete.title', { name: p?.name }),
          content: t('tree.delete.content'),
          okType: 'danger',
          okText: t('tree.delete.ok'),
          onOk: async () => {
            await api.deleteProfile(k.profileId)
            await qc.invalidateQueries({ queryKey: ['profiles'] })
          },
        })
      } else if (key === 'drop-table' && k.type === 'o') {
        dropTable(k.profileId, k.schema, k.name)
      } else if (key === 'copy') {
        await navigator.clipboard.writeText(qualifiedName(k))
        message.success(t('tree.copied'))
      } else if (key === 'refresh') {
        // 列节点刷新其所在的表
        const target: NodeKey =
          k.type === 'l' ? { type: 'o', profileId: k.profileId, schema: k.schema, kind: 'tables', name: k.table } : k
        await refresh(target)
      }
    } catch (e) {
      message.error((e as Error).message)
    }
  }

  return (
    <div className="tree" style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div className="row" style={{ padding: 6, gap: 6 }}>
        <Input
          size="small"
          allowClear
          prefix={<IconSearch size={16} className="muted" />}
          placeholder={t('tree.filterPlaceholder')}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <EnvFilter value={envs} onChange={setEnvs} />
      </div>
      {profilesError && <div className="err" style={{ padding: 8 }}>{(profilesError as Error).message}</div>}
      <Dropdown trigger={['contextMenu']} menu={{ items: shownItems, onClick: (e) => onMenu(e.key) }}>
        {/* 左右留白和上面的过滤框一致 */}
        <div ref={treeBox} className="grow" style={{ overflow: 'auto', padding: '0 6px' }}>
          <Tree
            blockNode
            showIcon
            treeData={treeData}
            expandedKeys={expanded}
            onExpand={(keys) => setExpanded(keys)}
            loadedKeys={Object.keys(loaded)}
            loadData={(node: EventDataNode<DataNode>) => load(String(node.key))}
            selectedKeys={selected}
            onSelect={(keys, { node }) => {
              setSelected(keys)
              selectProfile(decodeKey(String(node.key)).profileId)
            }}
            onDoubleClick={(_, node) => {
              const key = String(node.key)
              if (key.includes('\u0002')) return
              const k = decodeKey(key)
              // 双击用户、角色：打开账号权限并选中它
              if (k.type === 'p') useTabs.getState().openPrivileges(k.profileId, t('privilege.title'), undefined, k.id)
              else openData(k)
            }}
            onRightClick={({ node }) => {
              const key = String(node.key)
              setMenuNode(key.includes('\u0002') ? null : decodeKey(key))
            }}
          />
        </div>
      </Dropdown>
      {ddl && (
        <Suspense fallback={null}>
          <DdlDialog target={ddl} onClose={() => setDdl(null)} />
        </Suspense>
      )}
      {nsDialog && (
        <NamespaceDialog
          profileId={nsDialog.profileId}
          catalog={nsDialog.catalog}
          caps={nsDialog.caps}
          create={nsDialog.create}
          drop={nsDialog.drop}
          onClose={() => setNsDialog(null)}
          onDone={(change) => {
            message.success(t(change.op.startsWith('drop') ? 'tree.ns.dropped' : 'tree.ns.created', { name: change.name }))
            const inside = nsDialog.inside
            if (inside) {
              const tabs = useTabs.getState()
              for (const x of tabsInSchemas(tabs.tabs, nsDialog.profileId, inside)) tabs.close(x.id)
            }
            void refresh(nsDialog.after)
          }}
        />
      )}
      {principalDialog && (
        <PrincipalDialog
          profileId={principalDialog.profileId}
          action={principalDialog.action}
          onClose={() => setPrincipalDialog(null)}
          onDone={() => {
            const profileId = principalDialog.profileId
            void qc.invalidateQueries({ queryKey: ['privileges', profileId] })
            // 只刷新已展开的用户、角色文件夹，保持展开状态
            for (const folder of ['users', 'roles'] as const) {
              const node: NodeKey = { type: 'f', profileId, folder }
              if (loaded[encodeKey(node)]) void refresh(node)
            }
          }}
        />
      )}
    </div>
  )
}
