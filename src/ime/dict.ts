// 解析 scripts/build_dict.py 产出的二进制词典（格式说明见脚本开头）。

import { hiraganaToKatakana } from '../romaji'

export type UnknownPos =
  | 'noun'
  | 'number'
  | 'alphabet'
  | 'symbol'
  | 'open'
  | 'close'
  | 'period'
  | 'comma'
  | 'question'
  | 'exclamation'
  | 'tilde'

export interface DictMeta {
  mozcCommit: string
  posSize: number
  readings: number
  entries: number
  pairs: number
  segmenterR: number
  segmenterL: number
  unknownPos: Record<UnknownPos, number>
}

export interface Dict {
  meta: DictMeta
  /** 所有读音按排序拼接成的字符串，第 i 个读音是 readings.slice(readingOffsets[i], readingOffsets[i + 1]) */
  readings: string
  readingOffsets: Uint32Array
  /** 第 i 个读音的词条是 entryStart[i] ..< entryStart[i + 1] */
  entryStart: Uint32Array
  pairs: Uint16Array
  entryPair: Uint16Array
  entryCost: Uint16Array
  entryKind: Uint8Array
  /** 显式 surface 用 \n 拼接；entrySurface[e] 是它在 surfaceOffsets 里的下标，-1 表示由读音推出 */
  surfaces: string
  surfaceOffsets: Uint32Array
  entrySurface: Int32Array
  connection: Int16Array
  rclass: Uint16Array
  lclass: Uint16Array
  boundary: Uint8Array
}

const MAGIC = 0x444a5941 // "AYJD"
const VERSION = 1
const CHOON = 0x30fc // ー

export function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b
}

export function parseDict(buffer: ArrayBuffer): Dict {
  const view = new DataView(buffer)
  if (view.getUint32(0, true) !== MAGIC) throw new Error('词典文件格式不对')
  if (view.getUint32(4, true) !== VERSION) throw new Error('词典版本不匹配')
  const count = view.getUint32(8, true)
  const sections: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const offset = view.getUint32(12 + i * 8, true)
    const length = view.getUint32(16 + i * 8, true)
    sections.push(new Uint8Array(buffer, offset, length))
  }
  const [metaBytes, readingBytes, countBytes, pairBytes, pairIdx, costs, kinds, surfaceBytes, conn, seg] =
    sections

  const meta = JSON.parse(new TextDecoder().decode(metaBytes)) as DictMeta
  const u16 = (b: Uint8Array) => new Uint16Array(b.buffer, b.byteOffset, b.byteLength / 2)

  // 读音：front coding 还原。先算总长度，再一次性写入 UTF-16 buffer
  const nReadings = meta.readings
  let total = 0
  for (let p = 0, i = 0; i < nReadings; i++) {
    const shared = readingBytes[p]
    const suffix = readingBytes[p + 1]
    total += shared + suffix
    p += 2 + suffix
  }
  const chars = new Uint16Array(total)
  const readingOffsets = new Uint32Array(nReadings + 1)
  let prevStart = 0
  let pos = 0
  for (let p = 0, i = 0; i < nReadings; i++) {
    const shared = readingBytes[p]
    const suffix = readingBytes[p + 1]
    p += 2
    readingOffsets[i] = pos
    chars.copyWithin(pos, prevStart, prevStart + shared)
    pos += shared
    for (let k = 0; k < suffix; k++) {
      const code = readingBytes[p++]
      chars[pos++] = code === 87 ? CHOON : 0x3040 + code
    }
    prevStart = readingOffsets[i]
  }
  readingOffsets[nReadings] = pos
  const readings = decodeUtf16(chars)

  const entryStart = new Uint32Array(nReadings + 1)
  for (let p = 0, i = 0; i < nReadings; i++) {
    let n = 0
    let shift = 0
    let b: number
    do {
      b = countBytes[p++]
      n |= (b & 0x7f) << shift
      shift += 7
    } while (b & 0x80)
    entryStart[i + 1] = entryStart[i] + n
  }

  const surfaces = new TextDecoder().decode(surfaceBytes)
  const entryKind = kinds
  const entrySurface = new Int32Array(meta.entries)
  let explicit = 0
  for (let e = 0; e < meta.entries; e++) {
    entrySurface[e] = entryKind[e] === 0 ? explicit++ : -1
  }
  const surfaceOffsets = new Uint32Array(explicit + 1)
  for (let s = 1, p = 0; s <= explicit; s++) {
    const nl = surfaces.indexOf('\n', p)
    p = nl === -1 ? surfaces.length : nl
    surfaceOffsets[s] = p + 1
    p += 1
  }

  const n = meta.posSize
  const segU16 = new Uint16Array(seg.buffer, seg.byteOffset, n * 2)

  return {
    meta,
    readings,
    readingOffsets,
    entryStart,
    pairs: u16(pairBytes),
    entryPair: u16(pairIdx),
    entryCost: u16(costs),
    entryKind,
    surfaces,
    surfaceOffsets,
    entrySurface,
    connection: new Int16Array(conn.buffer, conn.byteOffset, conn.byteLength / 2),
    rclass: segU16.subarray(0, n),
    lclass: segU16.subarray(n, n * 2),
    boundary: new Uint8Array(seg.buffer, seg.byteOffset + n * 4, meta.segmenterR * meta.segmenterL),
  }
}

function decodeUtf16(chars: Uint16Array): string {
  // 分块拼接，避免 String.fromCharCode 参数过多
  let out = ''
  const CHUNK = 8192
  for (let i = 0; i < chars.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, chars.subarray(i, i + CHUNK) as unknown as number[])
  }
  return out
}

export function surfaceOf(dict: Dict, entry: number, reading: string): string {
  const s = dict.entrySurface[entry]
  if (s >= 0) return dict.surfaces.slice(dict.surfaceOffsets[s], dict.surfaceOffsets[s + 1] - 1)
  return dict.entryKind[entry] === 1 ? reading : hiraganaToKatakana(reading)
}
