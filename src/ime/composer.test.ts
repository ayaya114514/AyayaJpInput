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
})

describe('实时候选', () => {
  const surfaces = (composer: Composer) => composer.live?.items.map((x) => x.surface)
  const live = (composer: Composer) => composer.live!

  it('打字时就出候选：整句首选、第一个文節的候选、平假名；片假名单独一栏', async () => {
    const { composer, type, flush } = setup()
    type('kanaji')
    await flush()
    expect(composer.state?.mode).toBe('input')
    expect(surfaces(composer)).toEqual(['漢かな漢じ', '漢かな', 'かな', '別かな', 'かなじ'])
    expect(live(composer).katakana.surface).toBe('カナジ')
    expect(live(composer)).toMatchObject({ highlight: 0, active: false, expanded: false })
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

  it('点片假名栏确定整个读音的片假名', async () => {
    const { composer, committed, type, flush } = setup()
    type('ko-hi-')
    await flush()
    composer.pick(live(composer).items.length)
    expect(committed).toEqual(['コーヒー'])
  })

  it('数字键直接选当前行；没有候选时数字照常输入', async () => {
    const a = setup()
    a.type('kana')
    await a.flush()
    a.composer.handle({ type: 'digit', n: 2 })
    expect(a.committed).toEqual(['かな'])
    const b = setup(false)
    b.type('kana')
    b.composer.handle({ type: 'digit', n: 2 })
    expect(b.composer.text).toBe('かな2')
  })

  it('没动过高亮时 Enter 原样确定假名，Tab 移动后 Enter 确定高亮的', async () => {
    const a = setup()
    a.type('kanaji')
    await a.flush()
    await a.press('enter')
    expect(a.committed).toEqual(['かなじ'])
    const b = setup()
    b.type('kanaji')
    await b.flush()
    await b.press('tab', 'tab', 'shiftTab')
    expect(live(b.composer)).toMatchObject({ highlight: 1, active: true })
    await b.press('enter')
    expect(b.committed).toEqual(['漢かな'])
  })

  it('Shift+Tab 从第一个绕到片假名栏', async () => {
    const { composer, committed, type, flush, press } = setup()
    type('kanaji')
    await flush()
    await press('shiftTab')
    expect(live(composer).highlight).toBe(5)
    await press('enter')
    expect(committed).toEqual(['カナジ'])
  })

  it('= 展开、再按往下一行，- 往上一行，第一行再按 - 收起', async () => {
    const { composer, type, flush, press } = setup()
    type('kanaji')
    await flush()
    composer.setRows([0, 2, 4])
    await press('expand')
    expect(live(composer)).toMatchObject({ expanded: true, highlight: 0, active: true })
    await press('expand', 'right')
    expect(live(composer).highlight).toBe(3)
    // 最后一行只有一个，同列放不下就落到行尾
    await press('expand')
    expect(live(composer).highlight).toBe(4)
    await press('expand')
    expect(live(composer).highlight).toBe(4)
    composer.handle({ type: 'char', ch: '-' })
    expect(live(composer).highlight).toBe(2)
    composer.handle({ type: 'char', ch: '-' })
    composer.handle({ type: 'char', ch: '-' })
    expect(live(composer)).toMatchObject({ highlight: 0, expanded: false })
    expect(composer.text).toBe('かなじ')
  })

  it('没展开时 - 还是长音', async () => {
    const { composer, type, flush } = setup()
    type('ko')
    await flush()
    type('-')
    expect(composer.text).toBe('こー')
  })

  it('数字键选的是高亮所在的那一行', async () => {
    const { composer, committed, type, flush, press } = setup()
    type('kanaji')
    await flush()
    composer.setRows([0, 2, 4])
    await press('tab', 'tab')
    composer.handle({ type: 'digit', n: 2 })
    expect(committed).toEqual(['別かな'])
  })

  it('展开后 ↓ 从最后一行到片假名栏，↑ 回到最后一行', async () => {
    const { composer, type, flush, press } = setup()
    type('kanaji')
    await flush()
    composer.setRows([0, 2, 4])
    await press('expand', 'down', 'down', 'down')
    expect(live(composer).highlight).toBe(5)
    await press('up')
    expect(live(composer).highlight).toBe(4)
  })

  it('Esc 先退出候选再取消', async () => {
    const { composer, committed, type, flush, press } = setup()
    type('kanaji')
    await flush()
    await press('expand', 'tab')
    await press('escape')
    expect(live(composer)).toMatchObject({ highlight: 0, active: false, expanded: false })
    expect(composer.active).toBe(true)
    await press('escape')
    expect(composer.active).toBe(false)
    expect(committed).toEqual([''])
  })

  it('继续打字会收起候选并重新转换', async () => {
    const { composer, type, flush, press } = setup()
    type('kana')
    await flush()
    await press('expand', 'tab')
    type('ji')
    expect(live(composer)).toMatchObject({ highlight: 0, active: false, expanded: false })
    await flush()
    expect(surfaces(composer)?.[0]).toBe('漢かな漢じ')
  })

  it('没有候选时 Tab 和 = 不吃掉', () => {
    const { composer, type } = setup(false)
    type('kana')
    expect(composer.handle({ type: 'tab' })).toBe(false)
    expect(composer.handle({ type: 'expand' })).toBe(false)
  })

  it('Space 进入文節转换，实时候选消失', async () => {
    const { composer, type, flush, press } = setup()
    type('kana')
    await flush()
    await press('tab', 'space')
    expect(composer.state?.mode).toBe('convert')
    expect(composer.live).toBeNull()
  })
})
