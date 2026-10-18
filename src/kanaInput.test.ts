import { describe, expect, it } from 'vitest'
import { toHiragana, toKatakana } from './romaji'
import { backspace, typeChars, type Run } from './kanaInput'

// 模拟一个字一个字打进去
function typeAll(text: string, convert: (s: string) => string, start: Run = { buffer: '', display: '' }): Run {
  let run = start
  for (const ch of text) run = typeChars(run.buffer, ch, convert)
  return run
}

describe('平假名 / 片假名框就地转换', () => {
  it('逐字输入和整段转换结果一致', () => {
    expect(typeAll('konnichiha', toHiragana).display).toBe('こんにちは')
    expect(typeAll('kyouhaiitenki.', toHiragana).display).toBe('きょうはいいてんき。')
    expect(typeAll('ko-hi-', toKatakana).display).toBe('コーヒー')
  })

  it('n 先显示ん，接着打元音变成な', () => {
    expect(typeAll('kan', toHiragana).display).toBe('かん')
    expect(typeAll('kana', toHiragana).display).toBe('かな')
  })

  it('没拼完的辅音先原样显示', () => {
    expect(typeAll('ky', toHiragana).display).toBe('ky')
    expect(typeAll('kitt', toHiragana).display).toBe('きっt')
  })

  it('Backspace 删掉最后一个假名，之后接着打', () => {
    let run = typeAll('kya', toHiragana)
    run = backspace(run.display, toHiragana)
    expect(run.display).toBe('き')
    expect(typeAll('ta', toHiragana, run).display).toBe('きた')
    let kata = typeAll('terebi', toKatakana)
    kata = backspace(kata.display, toKatakana)
    expect(typeAll('ki', toKatakana, kata).display).toBe('テレキ')
  })
})
