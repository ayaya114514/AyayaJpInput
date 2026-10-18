// 输入法状态机：未确定的罗马音输入 → 转换 → 确定。不碰 DOM，方便单测。

import { hiraganaToKatakana, toHiragana } from '../romaji'
import type { Candidate, Segment } from './converter'

export const PAGE_SIZE = 9

export interface SegmentState extends Segment {
  index: number
}

/** 打字时实时给出的候选：选中后确定开头 reading 这一段，剩下的继续输入 */
export interface Suggestion {
  surface: string
  reading: string
  /** 选了文節的非首选时要学习 */
  learn?: Candidate
}

export interface Live {
  items: Suggestion[]
  /** -1 表示还没进入候选（Tab / = 进入） */
  highlight: number
  expanded: boolean
}

export type Composition =
  | { mode: 'input'; buffer: string }
  | { mode: 'convert'; kana: string; segments: SegmentState[]; focus: number }

export type Key =
  | { type: 'char'; ch: string }
  | { type: 'digit'; n: number }
  | {
      type:
        | 'space'
        | 'shiftSpace'
        | 'enter'
        | 'backspace'
        | 'escape'
        | 'left'
        | 'right'
        | 'shiftLeft'
        | 'shiftRight'
        | 'up'
        | 'down'
        | 'hiragana'
        | 'katakana'
        | 'tab'
        | 'shiftTab'
        | 'expand'
    }

export interface ComposerHost {
  /** 词典没就绪时返回 null */
  convert(kana: string, fixed: number[]): Promise<Segment[]> | null
  /** 打字时的实时候选，词典没就绪时返回 null，不提示 */
  suggest(kana: string): Promise<Segment[]> | null
  commit(text: string): void
  learn(reading: string, candidate: Candidate): void
  /** 从空闲进入输入状态时调用，host 记下插入位置 */
  start(): void
  changed(): void
}

/** 罗马音 buffer 对应的显示文字 */
export const displayOf = (buffer: string) => toHiragana(buffer)

export class Composer {
  state: Composition | null = null
  live: Live | null = null
  /** 展开后候选网格的列数，↑↓ 按行移动，由 host 按宽度设置 */
  columns = 5
  private requestId = 0

  constructor(private host: ComposerHost) {}

  get active() {
    return this.state !== null
  }

  /** 当前未确定的文字 */
  get text(): string {
    const s = this.state
    if (!s) return ''
    if (s.mode === 'input') return displayOf(s.buffer)
    return s.segments.map((seg) => seg.candidates[seg.index].surface).join('')
  }

  /** 返回 true 表示这个键被输入法吃掉了 */
  handle(key: Key): boolean {
    const s = this.state
    if (!s) {
      if (key.type !== 'char') return false
      this.host.start()
      this.setInput(key.ch)
      return true
    }
    return s.mode === 'input' ? this.handleInput(s, key) : this.handleConvert(s, key)
  }

  /** 外部事件（失焦、点击、粘贴）时把当前内容原样确定 */
  commitAll() {
    const s = this.state
    if (!s) return
    if (s.mode === 'convert') {
      for (const seg of s.segments) {
        if (seg.index > 0) this.host.learn(seg.reading, seg.candidates[seg.index])
      }
    }
    const text = this.text
    this.state = null
    this.live = null
    this.requestId++
    this.host.commit(text)
    this.host.changed()
  }

  private handleInput(s: { mode: 'input'; buffer: string }, key: Key): boolean {
    const live = this.live
    if (live && live.items.length > 0 && this.handleLive(live, key)) return true
    switch (key.type) {
      case 'char':
        this.setInput(s.buffer + key.ch)
        return true
      case 'digit':
        this.setInput(s.buffer + String(key.n))
        return true
      case 'backspace': {
        // 删掉最后一个显示出来的字；剩下的部分直接以假名形式留在 buffer 里
        const display = displayOf(s.buffer)
        this.setInput(display.slice(0, -1))
        return true
      }
      case 'escape':
        this.cancel()
        return true
      case 'enter':
        this.commitAll()
        return true
      case 'space':
      case 'shiftSpace':
      case 'down':
        this.startConvert(displayOf(s.buffer), [])
        return true
      case 'hiragana':
      case 'katakana':
        this.toKanaSegment(displayOf(s.buffer), key.type === 'katakana')
        return true
      case 'tab':
      case 'shiftTab':
      case 'expand':
        // 没有候选时交给浏览器（确定后照常 Tab / 打出 =）
        return false
      default:
        // 输入中左右键、上键不移动光标
        return true
    }
  }

  /** 实时候选里的移动和选择；返回 false 的键按普通输入处理 */
  private handleLive(live: Live, key: Key): boolean {
    const n = live.items.length
    const active = live.highlight >= 0
    const moveTo = (index: number) => {
      live.highlight = index
      this.host.changed()
    }
    switch (key.type) {
      case 'tab':
        moveTo(active ? (live.highlight + 1) % n : 0)
        return true
      case 'shiftTab':
        moveTo(active ? (live.highlight - 1 + n) % n : n - 1)
        return true
      case 'expand':
        live.expanded = !live.expanded
        if (live.expanded && !active) live.highlight = 0
        this.host.changed()
        return true
      case 'escape':
        if (!active && !live.expanded) return false
        live.highlight = -1
        live.expanded = false
        this.host.changed()
        return true
    }
    if (!active) return false
    switch (key.type) {
      case 'space':
        moveTo((live.highlight + 1) % n)
        return true
      case 'shiftSpace':
        moveTo((live.highlight - 1 + n) % n)
        return true
      case 'left':
        moveTo(Math.max(0, live.highlight - 1))
        return true
      case 'right':
        moveTo(Math.min(n - 1, live.highlight + 1))
        return true
      case 'up':
        if (live.expanded) moveTo(gridMove(live.items, live.highlight, -this.columns))
        return true
      case 'down':
        if (!live.expanded) {
          live.expanded = true
          this.host.changed()
        } else {
          moveTo(gridMove(live.items, live.highlight, this.columns))
        }
        return true
      case 'digit': {
        const page = Math.floor(live.highlight / PAGE_SIZE)
        const index = page * PAGE_SIZE + key.n - 1
        if (key.n >= 1 && index < n) this.pick(index)
        return true
      }
      case 'enter':
        this.pick(live.highlight)
        return true
    }
    return false
  }

  /** 选中实时候选：确定它覆盖的那一段，剩下的读音继续留在输入里 */
  pick(index: number) {
    const s = this.state
    const item = this.live?.items[index]
    if (!s || s.mode !== 'input' || !item) return
    const display = displayOf(s.buffer)
    // 结果还没跟上最新输入（比如刚删了字）时不确定
    if (!display.startsWith(item.reading)) return
    if (item.learn) this.host.learn(item.reading, item.learn)
    const rest = display.slice(item.reading.length)
    this.state = null
    this.live = null
    this.requestId++
    this.host.commit(item.surface)
    if (rest) {
      this.host.start()
      this.setInput(rest)
    } else {
      this.host.changed()
    }
  }

  private handleConvert(s: Extract<Composition, { mode: 'convert' }>, key: Key): boolean {
    const seg = s.segments[s.focus]
    const move = (delta: number) => {
      const n = seg.candidates.length
      seg.index = (seg.index + delta + n) % n
      this.host.changed()
    }
    switch (key.type) {
      case 'char':
        this.commitAll()
        return this.handle(key)
      case 'space':
      case 'down':
      case 'tab':
        move(1)
        return true
      case 'shiftSpace':
      case 'up':
      case 'shiftTab':
        move(-1)
        return true
      case 'expand':
        // 转换中的候选窗本来就是展开的
        return true
      case 'digit': {
        const page = Math.floor(seg.index / PAGE_SIZE)
        const index = page * PAGE_SIZE + key.n - 1
        if (key.n >= 1 && index < seg.candidates.length) this.select(index)
        return true
      }
      case 'left':
        s.focus = Math.max(0, s.focus - 1)
        this.host.changed()
        return true
      case 'right':
        s.focus = Math.min(s.segments.length - 1, s.focus + 1)
        this.host.changed()
        return true
      case 'shiftLeft':
      case 'shiftRight': {
        const len = seg.end - seg.start + (key.type === 'shiftLeft' ? -1 : 1)
        if (len < 1 || seg.start + len > s.kana.length) return true
        const fixed = s.segments.slice(0, s.focus).map((x) => x.end - x.start)
        this.startConvert(s.kana, [...fixed, len], s)
        return true
      }
      case 'enter':
        this.commitAll()
        return true
      case 'escape':
      case 'backspace':
        this.setInput(s.kana)
        return true
      case 'hiragana':
      case 'katakana':
        this.toKanaSegment(s.kana, key.type === 'katakana')
        return true
    }
  }

  /** 选中当前文節的某个候选（点击或数字键），然后跳到下一个文節 */
  select(index: number, segmentIndex?: number) {
    const s = this.state
    if (!s || s.mode !== 'convert') return
    if (segmentIndex !== undefined) s.focus = segmentIndex
    const seg = s.segments[s.focus]
    if (index < 0 || index >= seg.candidates.length) return
    seg.index = index
    if (s.focus < s.segments.length - 1) s.focus++
    this.host.changed()
  }

  focusSegment(i: number) {
    const s = this.state
    if (!s || s.mode !== 'convert' || i < 0 || i >= s.segments.length) return
    s.focus = i
    this.host.changed()
  }

  private setInput(buffer: string) {
    this.requestId++
    if (buffer === '') {
      this.cancel()
      return
    }
    this.state = { mode: 'input', buffer }
    // 旧候选先留着，等新结果回来再换，避免每个键都闪一下
    if (this.live) {
      this.live.highlight = -1
      this.live.expanded = false
    }
    this.host.changed()
    this.suggest(displayOf(buffer))
  }

  private suggest(display: string) {
    // 末尾还没拼完的罗马音（kyouhak 的 k）不参与转换
    const kana = display.replace(/[\x00-\x7f].*$/s, '')
    const pending = kana ? this.host.suggest(kana) : null
    if (!pending) {
      if (this.live) {
        this.live = null
        this.host.changed()
      }
      return
    }
    const id = this.requestId
    pending.then((segments) => {
      if (id !== this.requestId || this.state?.mode !== 'input') return
      this.live = { items: suggestionsOf(kana, segments), highlight: -1, expanded: false }
      this.host.changed()
    })
  }

  private cancel() {
    this.state = null
    this.live = null
    this.requestId++
    this.host.commit('')
    this.host.changed()
  }

  private startConvert(kana: string, fixed: number[], previous?: Extract<Composition, { mode: 'convert' }>) {
    const pending = this.host.convert(kana, fixed)
    if (!pending) return
    const id = ++this.requestId
    pending.then((segments) => {
      if (id !== this.requestId || segments.length === 0) return
      const states: SegmentState[] = segments.map((seg, i) => {
        // 调整文節长度时，前面已经选好的候选尽量保留
        const old = previous && i < fixed.length - 1 ? previous.segments[i] : undefined
        const keep = old ? seg.candidates.findIndex((c) => c.surface === old.candidates[old.index].surface) : -1
        return { ...seg, index: Math.max(0, keep) }
      })
      this.state = { mode: 'convert', kana, segments: states, focus: previous ? fixed.length - 1 : 0 }
      this.live = null
      this.host.changed()
    })
  }

  private toKanaSegment(kana: string, katakana: boolean) {
    this.requestId++
    const kata = hiraganaToKatakana(kana)
    const candidates: Candidate[] = [
      { surface: kana, lid: 0, rid: 0 },
      ...(kata !== kana ? [{ surface: kata, lid: 0, rid: 0 }] : []),
    ]
    const segment: SegmentState = {
      start: 0,
      end: kana.length,
      reading: kana,
      candidates,
      index: katakana && candidates.length > 1 ? 1 : 0,
    }
    this.state = { mode: 'convert', kana, segments: [segment], focus: 0 }
    this.live = null
    this.host.changed()
  }
}

/** 整句候选覆盖多个文節时比较长，展开后独占第一行 */
export const wholeRow = (items: Suggestion[]) => items.length > 1 && items[0].reading !== items[1].reading

/** 展开的网格里上下移动一行；delta 是 ±列数 */
function gridMove(items: Suggestion[], index: number, delta: number): number {
  const last = items.length - 1
  if (!wholeRow(items)) return Math.max(0, Math.min(last, index + delta))
  if (index === 0) return delta > 0 ? Math.min(1, last) : 0
  const next = index + delta
  return next < 1 ? 0 : Math.min(last, next)
}

/** 整句首选在最前，然后是第一个文節的各个候选，最后补平假名 / 片假名 */
export function suggestionsOf(kana: string, segments: Segment[]): Suggestion[] {
  if (segments.length === 0) return []
  const items: Suggestion[] = []
  const add = (item: Suggestion) => {
    if (!items.some((x) => x.surface === item.surface)) items.push(item)
  }
  add({ surface: segments.map((seg) => seg.candidates[0].surface).join(''), reading: kana })
  const first = segments[0]
  first.candidates.forEach((c, i) => add({ surface: c.surface, reading: first.reading, learn: i > 0 ? c : undefined }))
  add({ surface: kana, reading: kana })
  add({ surface: hiraganaToKatakana(kana), reading: kana })
  return items
}
