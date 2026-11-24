// 新建/编辑连接时的"数据库"栏：可以直接输入，也可以点开下拉，用当前填的主机、用户、密码临时连一次，从服务器读出库列表。
// 用于 MySQL 系、PG 系、SQL Server 的库，以及达梦、OceanBase Oracle 租户的模式（见 supportsDatabaseList）；连接信息没变时不重复读取。

import { AutoComplete, Spin } from 'antd'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useApi } from '../../app/context'
import { type ConnectionForm, toProfileInput } from './form'

/** 这一栏填的是模式（达梦、OceanBase 的 Oracle 租户）：填了以后对象树只显示这个模式。 */
export function isSchemaField(f: { driver: string; product?: string | null }): boolean {
  return f.driver === 'dameng' || f.product === 'oceanbase_oracle'
}

/** 这一栏能从服务器列出候选：MySQL 系、PG 系、SQL Server 列库，达梦和 OceanBase 的 Oracle 租户列模式。 */
export function supportsDatabaseList(f: Pick<ConnectionForm, 'driver' | 'product'>): boolean {
  return f.driver === 'mysql' || f.driver === 'postgres' || f.driver === 'sqlserver' || isSchemaField(f)
}

type ListState = { key: string; loading: boolean; names: string[]; error: string | null }

/** `editingId`：编辑已有连接时它的 id，密码框留空时后端用保存的密码。 */
export default function DatabaseInput({
  form,
  editingId,
  onChange,
}: {
  form: ConnectionForm
  editingId: string | null
  onChange(value: string): void
}) {
  const api = useApi()
  const { t } = useTranslation()
  const [list, setList] = useState<ListState | null>(null)
  // 读取时用到的连接信息：变了才重新读（数据库这一栏本身不算，免得边输入边读）
  const input = toProfileInput(form)
  const key = JSON.stringify({ ...input, database: null, name: null, password: form.password })

  const load = async () => {
    if (list?.key === key && (list.loading || !list.error)) return
    setList({ key, loading: true, names: [], error: null })
    try {
      const names = await api.listDatabases({ ...input, database: input.database || null }, form.password, editingId)
      setList((s) => (s?.key === key ? { key, loading: false, names, error: null } : s))
    } catch (e) {
      setList((s) => (s?.key === key ? { key, loading: false, names: [], error: (e as Error).message } : s))
    }
  }

  const schema = isSchemaField(form)
  const typed = form.database.trim().toLowerCase()
  const names = list?.key === key ? list.names : []
  const options = names.filter((n) => !typed || n.toLowerCase().includes(typed)).map((n) => ({ value: n }))
  const empty =
    list?.key !== key || list.loading ? (
      <Spin size="small" />
    ) : list.error ? (
      <span className="err">{t(schema ? 'connections.general.schemasFailed' : 'connections.general.databasesFailed', { error: list.error })}</span>
    ) : (
      <span className="muted">{t(schema ? 'connections.general.schemasEmpty' : 'connections.general.databasesEmpty')}</span>
    )

  return (
    <AutoComplete
      value={form.database}
      onChange={onChange}
      options={options}
      onOpenChange={(open) => open && void load()}
      notFoundContent={empty}
      placeholder={t(schema ? 'connections.general.schemaPickPlaceholder' : 'connections.general.databasePickPlaceholder')}
      allowClear
    />
  )
}
