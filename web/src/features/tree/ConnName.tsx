// 对象树里的连接名：悬停提示数据库类型和地址；名称被截断（显示了省略号）时，提示第一行再给出完整名称。

import { Tooltip } from 'antd'
import { useState } from 'react'

import type { Profile } from '../../shared/api'
import { profileKind } from '../connections/form'
import { productLabel, productOf } from '../connections/products'

/** 提示里的数据库类型：连接过、识别出变体（如金仓）时按识别结果；否则按新建时选的产品（PostgreSQL，而不是"PostgreSQL 系"）。 */
export function connKind(p: Pick<Profile, 'driver' | 'variant' | 'product'>): string {
  return p.variant ? profileKind(p).label : productLabel(productOf(p.driver, p.product))
}

/** 没有主机的本地库（如 SQLite）按本机显示。 */
export function connHost(p: Pick<Profile, 'host'>): string {
  return p.host?.trim() || '127.0.0.1'
}

/** 名称颜色跟环境标签的文字同色（shell.css 的 .conn-name.dev/.test/.prod），未设环境用默认色。 */
export default function ConnName({ profile }: { profile: Profile }) {
  const [truncated, setTruncated] = useState(false)
  const detail = `${connKind(profile)} · ${connHost(profile)}`
  return (
    <Tooltip
      title={
        truncated ? (
          <>
            <div>{profile.name}</div>
            <div>{detail}</div>
          </>
        ) : (
          detail
        )
      }
      mouseEnterDelay={0.4}
      placement="right"
    >
      <b
        className={`conn-name ${profile.environment ?? 'none'}`}
        onMouseEnter={(e) => setTruncated(e.currentTarget.scrollWidth > e.currentTarget.clientWidth)}
      >
        {profile.name}
      </b>
    </Tooltip>
  )
}
