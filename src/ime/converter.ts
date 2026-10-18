// 假名漢字変換：lattice + Viterbi 求最优路径，按 Mozc 的 segmenter 规则切文節，
// 再对每个文節做受限的 A* N-best 生成候选。

import { hiraganaToKatakana } from '../romaji'
import { surfaceOf, type Dict, type UnknownPos } from './dict'

export interface Word {
  reading: string
  surface: string
  lid: number
  rid: number
  cost: number
}

export interface Candidate {
  surface: string
  /** 第一个词的左词性 / 最后一个词的右词性，学习时要用 */
  lid: number
  rid: number
  /** 文節内路径的总代价（含左右连接），仅用于排序和调试 */
  cost?: number
  /** 组成这个候选的词，学习时按词记住 */
  words?: Word[]
}

export interface Segment {
  start: number
  end: number
  reading: string
  candidates: Candidate[]
}

export interface Learned {
  surface: string
  lid: number
  rid: number
  cost: number
}

/** 学过的词条：segment 是整个文節的选择，word 是文節里单个词的选择 */
export interface LearnedSet {
  segment: Map<string, Learned>
  word: Map<string, Learned>
}

interface Node {
  begin: number
  end: number
  lid: number
  rid: number
  cost: number
  surface: string
}

const BOS_EOS = 0
// 词典里没有的假名逐字兜底，cost 要明显高于常见词
const UNKNOWN_KANA_COST = 9000
const SYMBOL_COST = 0
const MAX_CANDIDATES = 30
// 放宽约束的路径大多是拼凑出来的，只补前几个
const LOOSE_CANDIDATES = 10
const MAX_POPS = 4000

const SYMBOL_POS: Record<string, UnknownPos> = {
  '。': 'period',
  '、': 'comma',
  '？': 'question',
  '！': 'exclamation',
  '「': 'open',
  '」': 'close',
  '〜': 'tilde',
}

const isKana = (ch: string) => (ch >= 'ぁ' && ch <= 'ゖ') || ch === 'ー'

export class Converter {
  private maxReading: number
  learned: LearnedSet = { segment: new Map(), word: new Map() }

  constructor(private dict: Dict) {
    let max = 0
    const off = dict.readingOffsets
    for (let i = 0; i + 1 < off.length; i++) max = Math.max(max, off[i + 1] - off[i])
    this.maxReading = max
  }

  conn(rid: number, lid: number): number {
    return this.dict.connection[rid * this.dict.meta.posSize + lid]
  }

  isBoundary(rid: number, lid: number): boolean {
    const d = this.dict
    return d.boundary[d.rclass[rid] * d.meta.segmenterL + d.lclass[lid]] === 1
  }

  /** 读音的二分查找：返回第一个 >= key 的下标 */
  private lowerBound(key: string): number {
    const { readings, readingOffsets } = this.dict
    let lo = 0
    let hi = readingOffsets.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (compareReading(readings, readingOffsets[mid], readingOffsets[mid + 1], key) < 0) lo = mid + 1
      else hi = mid
    }
    return lo
  }

  /** 列出从 begin 开始、能在词典里查到的所有读音（common prefix search） */
  private lookupPrefixes(text: string, begin: number): { reading: string; index: number }[] {
    const { readings, readingOffsets } = this.dict
    const found: { reading: string; index: number }[] = []
    const limit = Math.min(this.maxReading, text.length - begin)
    for (let len = 1; len <= limit; len++) {
      if (!isKana(text[begin + len - 1])) break
      const key = text.slice(begin, begin + len)
      const idx = this.lowerBound(key)
      if (idx >= readingOffsets.length - 1) break
      const s = readingOffsets[idx]
      const e = readingOffsets[idx + 1]
      if (e - s === len && readings.startsWith(key, s)) found.push({ reading: key, index: idx })
      else if (!readings.startsWith(key, s)) break // 没有以 key 开头的读音了
    }
    return found
  }

  buildLattice(text: string): Node[][] {
    const d = this.dict
    const byBegin: Node[][] = Array.from({ length: text.length }, () => [])
    for (let i = 0; i < text.length; i++) {
      const ch = text[i]
      for (const { reading, index } of this.lookupPrefixes(text, i)) {
        for (let e = d.entryStart[index]; e < d.entryStart[index + 1]; e++) {
          const p = d.entryPair[e] * 2
          byBegin[i].push({
            begin: i,
            end: i + reading.length,
            lid: d.pairs[p],
            rid: d.pairs[p + 1],
            cost: d.entryCost[e],
            surface: surfaceOf(d, e, reading),
          })
        }
      }
      // 只有词级别的学习进 lattice；整文節的学习只用来调整候选顺序，
      // 否则选过一次「葉」之后所有助词「は」都会被换掉
      for (const [reading, l] of this.learned.word) {
        if (text.startsWith(reading, i)) {
          byBegin[i].push({ begin: i, end: i + reading.length, lid: l.lid, rid: l.rid, cost: l.cost, surface: l.surface })
        }
      }
      const pos = d.meta.unknownPos
      if (isKana(ch)) {
        byBegin[i].push({ begin: i, end: i + 1, lid: pos.noun, rid: pos.noun, cost: UNKNOWN_KANA_COST, surface: ch })
      } else {
        const kind: UnknownPos =
          SYMBOL_POS[ch] ?? (/[0-9]/.test(ch) ? 'number' : /[A-Za-z]/.test(ch) ? 'alphabet' : 'symbol')
        byBegin[i].push({ begin: i, end: i + 1, lid: pos[kind], rid: pos[kind], cost: SYMBOL_COST, surface: ch })
      }
    }
    return byBegin
  }

  /**
   * 整句转换。fixed 是开头若干个已由用户调整过长度的文節，其余部分自动切分。
   */
  convert(text: string, fixed: number[] = []): Segment[] {
    if (!text) return []
    const lattice = this.buildLattice(text)
    const cuts = new Set<number>()
    let acc = 0
    for (const len of fixed) {
      acc += len
      cuts.add(acc)
    }
    const fixedEnd = acc
    const path = this.viterbi(text, lattice, cuts)

    // 切文節：固定部分按 fixed，之后按 segmenter 规则
    const bounds: number[] = [0]
    acc = 0
    for (const len of fixed) bounds.push((acc += len))
    for (let k = 1; k < path.length; k++) {
      const b = path[k].begin
      if (b <= fixedEnd) continue
      if (this.isBoundary(path[k - 1].rid, path[k].lid)) bounds.push(b)
    }
    if (bounds[bounds.length - 1] !== text.length) bounds.push(text.length)

    const segments: Segment[] = []
    for (let k = 0; k + 1 < bounds.length; k++) {
      const start = bounds[k]
      const end = bounds[k + 1]
      const left = path.find((n) => n.end === start)
      const right = path.find((n) => n.begin === end)
      const reading = text.slice(start, end)
      segments.push({
        start,
        end,
        reading,
        candidates: this.candidates(lattice, text, start, end, left?.rid ?? BOS_EOS, right?.lid ?? BOS_EOS),
      })
    }
    return segments
  }

  private viterbi(text: string, lattice: Node[][], cuts: Set<number>): Node[] {
    const n = text.length
    // items[k] 是一个已到达的节点；ending[pos] 存在 pos 结束的 item 下标
    const items: { node: Node; cost: number; prev: number }[] = []
    const ending: number[][] = Array.from({ length: n + 1 }, () => [])
    const crosses = (node: Node) => {
      for (let p = node.begin + 1; p < node.end; p++) if (cuts.has(p)) return true
      return false
    }

    for (let i = 0; i < n; i++) {
      if (i > 0 && ending[i].length === 0) continue
      for (const node of lattice[i]) {
        if (crosses(node)) continue
        let best = i === 0 ? this.conn(BOS_EOS, node.lid) : Infinity
        let bestPrev = -1
        for (const idx of i === 0 ? [] : ending[i]) {
          const c = items[idx].cost + this.conn(items[idx].node.rid, node.lid)
          if (c < best) {
            best = c
            bestPrev = idx
          }
        }
        items.push({ node, cost: best + node.cost, prev: bestPrev })
        ending[node.end].push(items.length - 1)
      }
    }

    let best = Infinity
    let last = -1
    for (const idx of ending[n]) {
      const c = items[idx].cost + this.conn(items[idx].node.rid, BOS_EOS)
      if (c < best) {
        best = c
        last = idx
      }
    }
    const path: Node[] = []
    for (let idx = last; idx >= 0; idx = items[idx].prev) path.unshift(items[idx].node)
    return path
  }

  /** 文節 [start, end) 的候选：受限 Viterbi 前向 + A* 反向 N-best */
  private candidates(lattice: Node[][], text: string, start: number, end: number, leftRid: number, rightLid: number): Candidate[] {
    // 先列严格不跨文節边界的路径，再补上允许内部分段的路径：
    // 词典里有整句平假名词条（よろしくおねがいします）时，「よろしくお願いします」只能从后者得到；
    // 用户把文節拉到奇怪长度时也只有后者
    const paths = [
      ...this.nbest(lattice, text, start, end, leftRid, rightLid, true),
      ...this.nbest(lattice, text, start, end, leftRid, rightLid, false).slice(0, LOOSE_CANDIDATES),
    ]

    const reading = text.slice(start, end)
    const out: Candidate[] = []
    const seen = new Set<string>()
    const push = (c: Candidate) => {
      if (seen.has(c.surface)) return
      seen.add(c.surface)
      out.push(c)
    }
    const learned = this.learned.segment.get(reading)
    if (learned) push({ ...learned })
    for (const p of paths) push(p)
    const pos = this.dict.meta.unknownPos
    push({ surface: reading, lid: pos.noun, rid: pos.noun })
    push({ surface: hiraganaToKatakana(reading), lid: pos.noun, rid: pos.noun })
    return out
  }

  nbest(lattice: Node[][], text: string, start: number, end: number, leftRid: number, rightLid: number, strict: boolean): Candidate[] {
    // 前向：f = 从文節开头到该节点（含节点 cost）的最小代价
    const nodes: Node[] = []
    const f = new Map<Node, number>()
    const endingAt = new Map<number, Node[]>()
    for (let i = start; i < end; i++) {
      for (const node of lattice[i]) {
        if (node.end > end) continue
        let best = Infinity
        if (i === start) {
          best = this.conn(leftRid, node.lid)
        } else {
          for (const p of endingAt.get(i) ?? []) {
            if (strict && this.isBoundary(p.rid, node.lid)) continue
            const c = f.get(p)! + this.conn(p.rid, node.lid)
            if (c < best) best = c
          }
        }
        if (best === Infinity) continue
        f.set(node, best + node.cost)
        nodes.push(node)
        const list = endingAt.get(node.end)
        if (list) list.push(node)
        else endingAt.set(node.end, [node])
      }
    }

    // 反向 A*：g = 节点右侧（不含节点本身 cost）的代价，f + g 是完整路径的精确代价
    interface Item {
      node: Node
      g: number
      next: Item | null
      priority: number
    }
    const heap = new MinHeap<Item>((a, b) => a.priority - b.priority)
    for (const node of endingAt.get(end) ?? []) {
      const g = this.conn(node.rid, rightLid)
      heap.push({ node, g, next: null, priority: f.get(node)! + g })
    }

    const out: Candidate[] = []
    const seen = new Set<string>()
    let pops = 0
    while (heap.size > 0 && out.length < MAX_CANDIDATES && pops++ < MAX_POPS) {
      const item = heap.pop()!
      if (item.node.begin === start) {
        const words: Word[] = []
        for (let it: Item | null = item; it; it = it.next) {
          const n = it.node
          words.push({ reading: text.slice(n.begin, n.end), surface: n.surface, lid: n.lid, rid: n.rid, cost: n.cost })
        }
        const surface = words.map((w) => w.surface).join('')
        if (!seen.has(surface)) {
          seen.add(surface)
          out.push({ surface, lid: words[0].lid, rid: words[words.length - 1].rid, cost: item.priority, words })
        }
        continue
      }
      for (const p of endingAt.get(item.node.begin) ?? []) {
        if (strict && this.isBoundary(p.rid, item.node.lid)) continue
        const g = this.conn(p.rid, item.node.lid) + item.node.cost + item.g
        heap.push({ node: p, g, next: item, priority: f.get(p)! + g })
      }
    }
    return out
  }
}

const LEARN_LIMIT = 1000
// 学过的词在 lattice 里降低的 cost；只学两个假名以上的词，单字太容易误伤
const WORD_LEARN_BONUS = 2500
const WORD_LEARN_MIN_LENGTH = 2

/** 记住用户在某个文節选的候选（就地修改 set） */
export function learnChoice(set: LearnedSet, reading: string, c: Candidate): void {
  remember(set.segment, reading, { surface: c.surface, lid: c.lid, rid: c.rid, cost: 0 })
  for (const w of c.words ?? []) {
    if (w.surface === w.reading || w.reading.length < WORD_LEARN_MIN_LENGTH) continue
    const prev = set.word.get(w.reading)
    // 已经学过同一个词时它的 cost 已经降过了，不要重复降
    const cost = prev?.surface === w.surface ? prev.cost : Math.max(0, w.cost - WORD_LEARN_BONUS)
    remember(set.word, w.reading, { surface: w.surface, lid: w.lid, rid: w.rid, cost })
  }
}

function remember(map: Map<string, Learned>, reading: string, value: Learned) {
  map.delete(reading) // Map 按插入顺序，删掉再插入相当于移到最新
  map.set(reading, value)
  while (map.size > LEARN_LIMIT) map.delete(map.keys().next().value!)
}

function compareReading(all: string, s: number, e: number, key: string): number {
  const len = Math.min(e - s, key.length)
  for (let i = 0; i < len; i++) {
    const d = all.charCodeAt(s + i) - key.charCodeAt(i)
    if (d !== 0) return d
  }
  return e - s - key.length
}

class MinHeap<T> {
  private items: T[] = []
  constructor(private less: (a: T, b: T) => number) {}

  get size() {
    return this.items.length
  }

  push(item: T) {
    const a = this.items
    a.push(item)
    let i = a.length - 1
    while (i > 0) {
      const parent = (i - 1) >> 1
      if (this.less(a[i], a[parent]) >= 0) break
      ;[a[i], a[parent]] = [a[parent], a[i]]
      i = parent
    }
  }

  pop(): T | undefined {
    const a = this.items
    if (a.length === 0) return undefined
    const top = a[0]
    const last = a.pop()!
    if (a.length > 0) {
      a[0] = last
      let i = 0
      for (;;) {
        const l = i * 2 + 1
        const r = l + 1
        let m = i
        if (l < a.length && this.less(a[l], a[m]) < 0) m = l
        if (r < a.length && this.less(a[r], a[m]) < 0) m = r
        if (m === i) break
        ;[a[i], a[m]] = [a[m], a[i]]
        i = m
      }
    }
    return top
  }
}
