// 数值列的表头靠右，和下面右对齐的数字对齐。查询结果（ResultGrid）和数据标签（EditableGrid）共用。
// 表格组件（glide-data-grid）的表头只会靠左，数值列由这里自己画：位置、字体、选中时的颜色和组件自带的一致。

import { type DrawHeaderCallback, getMiddleCenterBias } from '@glideapps/glide-data-grid'
import { useCallback, useMemo } from 'react'

import type { ResultSet } from '../../shared/exec'
import { isNumericColumn } from './cell'

/** 列类型为空时按前 200 行判断；只在列信息和第一批行到达时算一次，续取的行不影响。 */
export function useNumericHeader(result: ResultSet): DrawHeaderCallback {
  const hasRows = result.rows.length > 0
  const numeric = useMemo(
    () =>
      new Set(
        result.columns.flatMap((c, i) =>
          isNumericColumn(c.type_name, result.rows.slice(0, 200).map((r) => r[i] ?? { t: 'null' })) ? [i] : [],
        ),
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [result.columns, hasRows],
  )
  return useCallback(
    ({ ctx, rect, theme, column, columnIndex, isSelected }, drawContent) => {
      if (!numeric.has(columnIndex)) return drawContent()
      const font = `${theme.headerFontStyle} ${theme.fontFamily}`
      ctx.save()
      ctx.beginPath()
      ctx.rect(rect.x, rect.y, rect.width, rect.height)
      ctx.clip()
      ctx.font = font
      ctx.fillStyle = isSelected ? theme.textHeaderSelected : theme.textHeader
      ctx.textAlign = 'right'
      ctx.fillText(column.title, rect.x + rect.width - theme.cellHorizontalPadding, rect.y + rect.height / 2 + getMiddleCenterBias(ctx, font))
      ctx.restore()
    },
    [numeric],
  )
}
