import { describe, expect, it } from 'vitest'

import i18n from '../../shared/i18n'
import { cellBytes, cellFullText, formatBytes, hexDump, isNumeric, isNumericColumn, lobNote, prettyJson } from './cell'

const lob = { t: 'lob', v: { preview: '客户反馈', total_len: 2355, truncated: true, binary: false } }

describe('单元格查看', () => {
  it('文本视图显示大字段的完整预览', () => {
    expect(cellFullText(lob)).toBe('客户反馈')
    expect(cellFullText({ t: 'string', v: 'a\nb' })).toBe('a\nb')
    expect(cellFullText({ t: 'null' })).toBe('NULL')
    expect(lobNote(lob)).toBe('2.3 KB · 已截断预览')
    expect(lobNote({ t: 'int', v: 1 })).toBeNull()
    expect(formatBytes(10)).toBe('10 B')
    expect(formatBytes(3 * 1024 * 1024)).toBe('3.0 MB')
  })

  it('JSON 视图只对对象和数组提供', () => {
    expect(prettyJson({ t: 'json', v: { a: [1] } })).toBe('{\n  "a": [\n    1\n  ]\n}')
    expect(prettyJson({ t: 'string', v: ' [1,2]' })).toBe('[\n  1,\n  2\n]')
    expect(prettyJson({ t: 'string', v: '{bad' })).toBeNull()
    expect(prettyJson({ t: 'int', v: 5 })).toBeNull()
  })

  it('十六进制视图：二进制按 base64 解码，文本按 UTF-8', () => {
    expect(Array.from(cellBytes({ t: 'bytes', v: btoa('\x00\xffA') }))).toEqual([0, 255, 65])
    expect(Array.from(cellBytes({ t: 'string', v: '数' }))).toEqual([0xe6, 0x95, 0xb0])
    const dump = hexDump(new TextEncoder().encode('Hello, DATLUMA 数览!'))
    expect(dump.split('\n')[0]).toBe('00000000  48 65 6c 6c 6f 2c 20 44 41 54 4c 55 4d 41 20 e6  |Hello, DATLUMA .|')
    expect(dump.split('\n')).toHaveLength(2)
    expect(hexDump(new Uint8Array(40), 16).split('\n').at(-1)).toBe('…（共 40 字节，只显示前 16 字节）')
  })

  it('英文界面：说明文字按当前语言', async () => {
    await i18n.changeLanguage('en')
    try {
      expect(lobNote(lob)).toBe('2.3 KB · preview truncated')
      expect(hexDump(new Uint8Array(40), 16).split('\n').at(-1)).toBe(
        '… (40 bytes in total, showing the first 16 bytes)',
      )
    } finally {
      await i18n.changeLanguage('zh-CN')
    }
  })

  it('数值右对齐', () => {
    expect(isNumeric({ t: 'decimal', v: '1.5' })).toBe(true)
    expect(isNumeric({ t: 'string', v: '1' })).toBe(false)
  })
})

describe('数值列（决定表头靠右）', () => {
  it('按类型名判断，忽略大小写、长度和精度', () => {
    for (const t of ['INTEGER', 'bigint', 'NUMBER(10,2)', 'decimal(18, 4)', 'REAL', 'double precision', 'int8', 'float8', 'money']) {
      expect(isNumericColumn(t, []), t).toBe(true)
    }
    for (const t of ['TEXT', 'varchar(20)', 'DATE', 'timestamp', 'interval', 'bool', 'json', 'point', 'internal']) {
      expect(isNumericColumn(t, []), t).toBe(false)
    }
  })

  it('类型名为空时看已加载的值', () => {
    expect(isNumericColumn('', [{ t: 'int', v: 1 }, { t: 'null' }])).toBe(true)
    expect(isNumericColumn('', [{ t: 'int', v: 1 }, { t: 'string', v: 'a' }])).toBe(false)
    expect(isNumericColumn('', [{ t: 'null' }])).toBe(false)
  })

  it('有类型名时整列 NULL 也按类型', () => {
    expect(isNumericColumn('INTEGER', [{ t: 'null' }])).toBe(true)
  })
})
