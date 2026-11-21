import { describe, expect, it } from 'vitest'

import { looksLikeSql } from './context'
import { mcpConfig } from './McpSnippet'
import { proseLines, splitAnswer } from './store'

describe('splitAnswer', () => {
  it('separates prose and code blocks', () => {
    expect(splitAnswer('原因：少了逗号\n```sql\nSELECT a, b\nFROM t\n```\n改好了')).toEqual([
      { code: false, lang: '', text: '原因：少了逗号\n' },
      { code: true, lang: 'sql', text: 'SELECT a, b\nFROM t' },
      { code: false, lang: '', text: '\n改好了' },
    ])
  })
  it('keeps plain text and drops empty parts', () => {
    expect(splitAnswer('只有文字')).toEqual([{ code: false, lang: '', text: '只有文字' }])
    expect(splitAnswer('```\nSELECT 1\n```')).toEqual([{ code: true, lang: '', text: 'SELECT 1' }])
    expect(splitAnswer('1. 建索引\n   ```sql\n   CREATE INDEX i\n     ON t (a)\n   ```')[1].text).toBe('CREATE INDEX i\n  ON t (a)')
  })
})

describe('looksLikeSql', () => {
  it('accepts statements only', () => {
    expect(looksLikeSql('  select * from t')).toBe(true)
    expect(looksLikeSql('WITH x AS (SELECT 1) SELECT * FROM x')).toBe(true)
    expect(looksLikeSql('selection')).toBe(false)
    expect(looksLikeSql('hello')).toBe(false)
  })
})

describe('mcpConfig', () => {
  it('points at the desktop exe or the server command', () => {
    expect(JSON.parse(mcpConfig('C:\\DBLENS\\DBLENS.exe', true)).mcpServers.dblens).toEqual({
      command: 'C:\\DBLENS\\DBLENS.exe',
      args: ['--mcp'],
    })
    expect(JSON.parse(mcpConfig(null, false)).mcpServers.dblens).toEqual({ command: 'dblens-server', args: ['mcp'] })
  })
})

describe('proseLines', () => {
  it('recognizes headings, rules, bold and inline code', () => {
    expect(proseLines('### **建议**\n---\n为 `a` 建**索引**')).toEqual([
      { kind: 'heading', parts: [{ kind: 'bold', text: '建议' }] },
      { kind: 'rule' },
      {
        kind: 'line',
        parts: [
          { kind: 'text', text: '为 ' },
          { kind: 'code', text: 'a' },
          { kind: 'text', text: ' 建' },
          { kind: 'bold', text: '索引' },
        ],
      },
    ])
    expect(proseLines('**2. 优化 `SELECT *` 写法**')[0]).toEqual({
      kind: 'line',
      parts: [{ kind: 'bold', text: '2. 优化 `SELECT *` 写法' }],
    })
  })
})
