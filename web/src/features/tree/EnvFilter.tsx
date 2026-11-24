// 对象树按环境过滤：多选开发、测试、生产、本机环境，顶部"全选"。默认全选，框里显示"全部环境"。
// 只在本次打开期间有效，不记住：下次打开看到全部连接，免得以为连接丢了。

import { Checkbox, Select } from 'antd'
import { useTranslation } from 'react-i18next'

import type { Environment } from '../../shared/api'

export const ALL_ENVS: Environment[] = ['dev', 'test', 'prod', 'none']

export default function EnvFilter({ value, onChange }: { value: Environment[]; onChange(v: Environment[]): void }) {
  const { t } = useTranslation()
  const all = value.length === ALL_ENVS.length
  const summary = all
    ? t('tree.envFilter.all')
    : value.length === 0
      ? t('tree.envFilter.none')
      : ALL_ENVS.filter((e) => value.includes(e)).map((e) => t(`tree.env.${e}`)).join('、')
  return (
    <Select<Environment[]>
      size="small"
      mode="multiple"
      value={value}
      onChange={onChange}
      options={ALL_ENVS.map((e) => ({ value: e, label: t(`tree.env.${e}`) }))}
      // 选中项不逐个显示成标签，框里只放一句概括
      maxTagCount={0}
      maxTagPlaceholder={() => summary}
      showSearch={false}
      popupMatchSelectWidth={false}
      popupRender={(menu) => (
        <>
          <div style={{ padding: '4px 12px' }}>
            <Checkbox
              checked={all}
              indeterminate={!all && value.length > 0}
              onChange={(e) => onChange(e.target.checked ? ALL_ENVS : [])}
            >
              {t('tree.envFilter.selectAll')}
            </Checkbox>
          </div>
          {menu}
        </>
      )}
      title={summary}
      // 样式跟主题（shell.css 的 .env-filter）：框里是纯文字，下拉里选中项不铺底色、只打勾
      className="env-filter"
      classNames={{ popup: { root: 'env-filter-popup' } }}
      style={{ width: 120, flex: 'none' }}
    />
  )
}
