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
    suggest: (kana) => (ready ? Promise.resolve(fakeConvert(kana, [])) : null),
    commit: (text) => committed.push(text),
    learn: (reading, c) => learned.push([reading, c]),
    start: () => starts++,
    changed: () => {},
  })
  const type = (s: string) => {
    for (const ch of s) composer.handle({ type: 'char', ch })
  }
  const flush = async () => {
    await Promise.resolve()
    await Promise.resolve()
  }
  const press = async (...keys: Key['type'][]) => {
    // 转换结果是异步回来的，每个键之后都等一下
    for (const type of keys) {
      composer.handle({ type } as Key)
      await Promise.resolve()
      await Promise.resolve()
    }
  }
  return { composer, committed, learned, type, press, flush, starts: () => starts }
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

describe('实时候选', () => {
  const surfaces = (composer: Composer) => composer.live?.items.map((x) => x.surface)

  it('打字时就出候选：整句首选、第一个文節的候选、平假名、片假名', async () => {
    const { composer, type, flush } = setup()
    type('kanaji')
    await flush()
    expect(composer.state?.mode).toBe('input')
    expect(surfaces(composer)).toEqual(['漢かな漢じ', '漢かな', 'かな', '別かな', 'かなじ', 'カナジ'])
    expect(composer.live?.highlight).toBe(-1)
  })

  it('末尾没拼完的罗马音不参与转换', async () => {
    const { composer, type, flush } = setup()
    type('kanak')
    await flush()
    expect(surfaces(composer)?.[0]).toBe('漢かな')
    composer.pick(0)
    expect(composer.text).toBe('k')
  })

  it('点整句候选直接确定', async () => {
    const { composer, committed, type, flush } = setup()
    type('kanaji')
    await flush()
    composer.pick(0)
    expect(committed).toEqual(['漢かな漢じ'])
    expect(composer.active).toBe(false)
    expect(composer.live).toBeNull()
  })

  it('选第一个文節的候选只确定这一段，剩下的继续输入并学习', async () => {
    const { composer, committed, learned, type, flush, starts } = setup()
    type('kanaji')
    await flush()
    composer.pick(3)
    expect(committed).toEqual(['別かな'])
    expect(learned).toEqual([['かな', { surface: '別かな', lid: 1, rid: 1 }]])
    expect(composer.state).toEqual({ mode: 'input', buffer: 'じ' })
    expect(starts()).toBe(2)
    await flush()
    expect(surfaces(composer)?.[0]).toBe('漢じ')
  })

  it('Tab 进入候选，Enter 确定高亮的那个', async () => {
    const { composer, committed, type, flush, press } = setup()
    type('kanaji')
    await flush()
    await press('tab', 'tab', 'shiftTab', 'tab')
    expect(composer.live?.highlight).toBe(1)
    await press('enter')
    expect(committed).toEqual(['漢かな'])
  })

  it('没进入候选时数字照常输入，进入后数字选当前页', async () => {
    const { composer, committed, type, flush, press } = setup()
    type('kana')
    await flush()
    composer.handle({ type: 'digit', n: 2 })
    expect(composer.text).toBe('かな2')
    await flush()
    await press('tab')
    composer.handle({ type: 'digit', n: 1 })
    expect(committed).toEqual(['漢かな'])
    expect(composer.text).toBe('2')
  })

  it('= 展开并高亮第一个，展开后 ↓ 按行移动，Esc 先收起再取消', async () => {
    const { composer, committed, type, flush, press } = setup()
    composer.columns = 2
    // 只有一个文節，没有独占一行的整句候选
    type('kana')
    await flush()
    await press('expand')
    expect(composer.live).toMatchObject({ expanded: true, highlight: 0 })
    await press('down', 'right')
    expect(composer.live?.highlight).toBe(3)
    await press('escape')
    expect(composer.live).toMatchObject({ expanded: false, highlight: -1 })
    expect(composer.active).toBe(true)
    await press('escape')
    expect(composer.active).toBe(false)
    expect(committed).toEqual([''])
  })

  it('整句独占第一行时 ↑↓ 按这个布局移动', async () => {
    const { composer, type, flush, press } = setup()
    composer.columns = 2
    type('kanaji')
    await flush()
    // 第一行：漢かな漢じ；之后每行两个：漢かな かな / 別かな かなじ / カナジ
    await press('expand', 'down')
    expect(composer.live?.highlight).toBe(1)
    await press('down', 'right', 'down')
    expect(composer.live?.highlight).toBe(5)
    await press('up', 'up', 'up')
    expect(composer.live?.highlight).toBe(0)
  })

  it('继续打字会收起候选并重新转换', async () => {
    const { composer, type, flush, press } = setup()
    type('kana')
    await flush()
    await press('expand')
    type('ji')
    expect(composer.live).toMatchObject({ expanded: false, highlight: -1 })
    await flush()
    expect(surfaces(composer)?.[0]).toBe('漢かな漢じ')
  })

  it('没有候选时 Tab 和 = 不吃掉', () => {
    const { composer, type } = setup(false)
    type('kana')
    expect(composer.handle({ type: 'tab' })).toBe(false)
    expect(composer.handle({ type: 'expand' })).toBe(false)
  })

  it('Space 转换后实时候选消失', async () => {
    const { composer, type, flush, press } = setup()
    type('kana')
    await flush()
    await press('space')
    expect(composer.state?.mode).toBe('convert')
    expect(composer.live).toBeNull()
  })
})
