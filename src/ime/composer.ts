// 输入法状态机：未确定的罗马音输入 → 转换 → 确定。不碰 DOM，方便单测。

import { hiraganaToKatakana, toHiragana } from '../romaji'
import type { Candidate, Segment } from './converter'

export const PAGE_SIZE = 9

export interface SegmentState extends Segment {
  index: number
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
    }

export interface ComposerHost {
  /** 词典没就绪时返回 null */
  convert(kana: string, fixed: number[]): Promise<Segment[]> | null
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
    this.requestId++
    this.host.commit(text)
    this.host.changed()
  }

  private handleInput(s: { mode: 'input'; buffer: string }, key: Key): boolean {
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
      default:
        // 输入中左右键、上键不移动光标
        return true
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
        move(1)
        return true
      case 'shiftSpace':
      case 'up':
        move(-1)
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
    this.host.changed()
  }

  private cancel() {
    this.state = null
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
    this.host.changed()
  }
}
