import { readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import { toHiragana } from '../romaji'
import { Converter, learnChoice, type Segment } from './converter'
import { parseDict, type Dict } from './dict'

let dict: Dict

beforeAll(() => {
  const buf = gunzipSync(readFileSync(new URL('../../dict/mozc.bin.gz', import.meta.url)))
  dict = parseDict(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength))
})

const top = (segs: Segment[]) => segs.map((s) => s.candidates[0].surface).join('')
const convert = (romaji: string) => new Converter(dict).convert(toHiragana(romaji))

describe('词典解析', () => {
  it('读音和词条数与 meta 一致', () => {
    expect(dict.readingOffsets.length).toBe(dict.meta.readings + 1)
    expect(dict.entryStart[dict.meta.readings]).toBe(dict.meta.entries)
  })
})

describe('首选转换', () => {
  const cases: [string, string][] = [
    ['kyouhaiitenkidesu', '今日はいい天気です'],
    ['watashihagakuseidesu', '私は学生です'],
    ['nihongowobenkyoushiteimasu', '日本語を勉強しています'],
    ['toukyouniikitai', '東京に行きたい'],
    ['kishanokishagakishadekishashita', '記者の記者が記者で帰社した'],
    ['karehafuruihonwoyonda', '彼は古い本を読んだ'],
    ['ko-hi-wonomimasu', 'コーヒーを飲みます'],
    ['terebiwomiru', 'テレビを見る'],
    ['pasokonwokau', 'パソコンを買う'],
    ['kono shousetsuhaomoshiroi.', 'この 小説は面白い。'],
  ]
  for (const [romaji, expected] of cases) {
    it(`${romaji} → ${expected}`, () => expect(top(convert(romaji))).toBe(expected))
  }
})

describe('文節和候选', () => {
  it('按文節切分', () => {
    const segs = convert('watashihagakuseidesu')
    expect(segs.map((s) => s.reading)).toEqual(['わたしは', 'がくせいです'])
    expect(segs[0].start).toBe(0)
    expect(segs[1].end).toBe('わたしはがくせいです'.length)
  })

  it('同音词都在候选里，末尾有平假名和片假名', () => {
    const segs = convert('kishanokishagakishadekishashita')
    const surfaces = segs[0].candidates.map((c) => c.surface)
    expect(surfaces).toEqual(expect.arrayContaining(['記者の', '貴社の', '汽車の', 'きしゃの', 'キシャノ']))
  })

  it('整句平假名词条之外也能给出拆开转换的候选', () => {
    const surfaces = convert('yoroshikuonegaishimasu')[0].candidates.map((c) => c.surface)
    expect(surfaces).toContain('よろしくお願いします')
  })

  it('fixed 固定开头文節的长度', () => {
    const conv = new Converter(dict)
    const segs = conv.convert('きょうはいいてんきです', [3])
    expect(segs[0].reading).toBe('きょう')
    expect(segs.map((s) => s.reading).join('')).toBe('きょうはいいてんきです')
  })

  it('词典里没有的假名和符号原样保留', () => {
    expect(top(convert('piyopiyo'))).toBe('ぴよぴよ')
    const segs = convert('nani?')
    expect(segs[segs.length - 1].candidates[0].surface).toBe('？')
  })
})

describe('学习', () => {
  it('选过的文節候选排到最前', () => {
    const conv = new Converter(dict)
    const seg = conv.convert('きしゃ')[0]
    const kisha = seg.candidates.find((c) => c.surface === '汽車')!
    learnChoice(conv.learned, seg.reading, kisha)
    expect(conv.convert('きしゃ')[0].candidates[0].surface).toBe('汽車')
  })

  it('选过的词在别的句子里也优先', () => {
    const conv = new Converter(dict)
    const segs = conv.convert('あめがふるでしょう')
    const last = segs[segs.length - 1]
    const furu = last.candidates.find((c) => c.surface === '降るでしょう')!
    learnChoice(conv.learned, last.reading, furu)
    expect(top(conv.convert('ゆきがふる'))).toBe('雪が降る')
  })

  it('单个假名的词不进 lattice，不会把助词换掉', () => {
    const conv = new Converter(dict)
    const ha = conv.convert('は')[0].candidates.find((c) => c.surface === '葉')!
    learnChoice(conv.learned, 'は', ha)
    expect(conv.learned.word.has('は')).toBe(false)
    expect(top(conv.convert('わたしはがくせいです'))).toBe('私は学生です')
  })
})
