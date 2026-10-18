import { describe, expect, it } from 'vitest'
import { Composer, type Key } from './composer'
import type { Candidate, Segment } from './converter'

// 假转换器：每两个假名一个文節，候选是「漢{读音}」和读音本身
function fakeConvert(kana: string, fixed: number[]): Segment[] {
  const bounds = [0]
  for (const len of fixed) bounds.push(bounds[bounds.length - 1] + len)
  while (bounds[bounds.length - 1] < kana.length) bounds.push(Math.min(kana.length, bounds[bounds.length - 1] + 2))
  const segs: Segment[] = []
  for (let i = 0; i + 1 < bounds.length; i++) {
    const reading = kana.slice(bounds[i], bounds[i + 1])
    segs.push({
      start: bounds[i],
      end: bounds[i + 1],
      reading,
      candidates: [`漢${reading}`, reading, `別${reading}`].map((surface) => ({ surface, lid: 1, rid: 1 })),
    })
  }
  return segs
}

function setup(ready = true) {
  const committed: string[] = []
  const learned: [string, Candidate][] = []
  let starts = 0
  const composer = new Composer({
    convert: (kana, fixed) => (ready ? Promise.resolve(fakeConvert(kana, fixed)) : null),
    commit: (text) => committed.push(text),
    learn: (reading, c) => learned.push([reading, c]),
    start: () => starts++,
    changed: () => {},
  })
  const type = (s: string) => {
    for (const ch of s) composer.handle({ type: 'char', ch })
  }
  const press = async (...keys: Key['type'][]) => {
    // 转换结果是异步回来的，每个键之后都等一下
    for (const type of keys) {
      composer.handle({ type } as Key)
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  return { composer, committed, learned, type, press, starts: () => starts }
}

describe('输入状态', () => {
  it('罗马音实时显示为假名', () => {
    const { composer, type, starts } = setup()
    type('kana')
    expect(composer.text).toBe('かな')
    expect(starts()).toBe(1)
  })

  it('Backspace 删掉最后一个假名', async () => {
    const { composer, type, press } = setup()
    type('kya')
    await press('backspace')
    expect(composer.text).toBe('き')
    await press('backspace')
    expect(composer.active).toBe(false)
    type('kanji')
    await press('backspace')
    expect(composer.text).toBe('かん')
    type('a')
    expect(composer.text).toBe('かんあ')
  })

  it('Enter 原样确定假名，Esc 取消', async () => {
    const { committed, type, press } = setup()
    type('sushi')
    await press('enter')
    type('abc')
    await press('escape')
    expect(committed).toEqual(['すし', ''])
  })

  it('空闲时非输入键不处理', () => {
    const { composer } = setup()
    expect(composer.handle({ type: 'space' })).toBe(false)
    expect(composer.handle({ type: 'enter' })).toBe(false)
  })

  it('词典没就绪时 Space 保持输入状态', async () => {
    const { composer, type, press } = setup(false)
    type('kana')
    await press('space')
    expect(composer.state?.mode).toBe('input')
  })
})

describe('转换状态', () => {
  it('Space 转换，再按 Space 换候选，Enter 确定并学习非首选', async () => {
    const { composer, committed, learned, type, press } = setup()
    type('kanaji')
    await press('space')
    expect(composer.state?.mode).toBe('convert')
    expect(composer.text).toBe('漢かな漢じ')
    await press('space')
    expect(composer.text).toBe('かな漢じ')
    await press('enter')
    expect(committed).toEqual(['かな漢じ'])
    expect(learned).toEqual([['かな', { surface: 'かな', lid: 1, rid: 1 }]])
  })

  it('←→ 切换文節，↑ 往回选候选', async () => {
    const { composer, type, press } = setup()
    type('kanaji')
    await press('space', 'right', 'up')
    expect(composer.text).toBe('漢かな別じ')
    await press('left', 'down')
    expect(composer.text).toBe('かな別じ')
  })

  it('数字键选当前页候选并跳到下一个文節', async () => {
    const { composer, type, press } = setup()
    type('kanaji')
    await press('space')
    composer.handle({ type: 'digit', n: 3 })
    expect(composer.text).toBe('別かな漢じ')
    expect(composer.state?.mode === 'convert' && composer.state.focus).toBe(1)
  })

  it('Shift+→ 拉长当前文節，前面选好的候选保留', async () => {
    const { composer, type, press } = setup()
    type('kanajikuta')
    await press('space', 'down', 'right', 'shiftRight')
    const s = composer.state
    expect(s?.mode).toBe('convert')
    if (s?.mode !== 'convert') return
    expect(s.segments.map((x) => x.reading)).toEqual(['かな', 'じくた'])
    expect(s.segments[0].candidates[s.segments[0].index].surface).toBe('かな')
    expect(s.focus).toBe(1)
  })

  it('Shift+← 不会把文節缩到 0', async () => {
    const { composer, type, press } = setup()
    type('ka')
    await press('space', 'shiftLeft')
    expect(composer.state?.mode === 'convert' && composer.state.segments[0].reading).toBe('か')
    await press('shiftLeft')
    expect(composer.state?.mode === 'convert' && composer.state.segments[0].reading).toBe('か')
  })

  it('Esc 回到假名输入', async () => {
    const { composer, type, press } = setup()
    type('kana')
    await press('space', 'escape')
    expect(composer.state).toEqual({ mode: 'input', buffer: 'かな' })
  })

  it('转换中继续打字会先确定', async () => {
    const { composer, committed, type, press } = setup()
    type('kana')
    await press('space')
    type('ka')
    expect(committed).toEqual(['漢かな'])
    expect(composer.text).toBe('か')
  })

  it('F7 片假名、F6 平假名', async () => {
    const { composer, type, press } = setup()
    type('ko-hi-')
    await press('katakana')
    expect(composer.text).toBe('コーヒー')
    await press('hiragana')
    expect(composer.text).toBe('こーひー')
  })
})
