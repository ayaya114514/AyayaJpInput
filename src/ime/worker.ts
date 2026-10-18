/// <reference lib="webworker" />
// 词典加载和转换都放在 worker 里，主线程只负责输入和渲染。

import { Converter, type Learned, type Segment } from './converter'
import { isGzip, parseDict } from './dict'

export type WorkerRequest =
  | { type: 'init'; url: string; learned: SerializedLearned }
  | { type: 'convert'; id: number; kana: string; fixed: number[] }
  | { type: 'learned'; learned: SerializedLearned }

export type WorkerResponse =
  | { type: 'progress'; loaded: number; total: number }
  | { type: 'ready'; ms: number }
  | { type: 'error'; message: string }
  | { type: 'result'; id: number; segments: Segment[] }

export interface SerializedLearned {
  segment: [string, Learned][]
  word: [string, Learned][]
}

declare const self: DedicatedWorkerGlobalScope

let converter: Converter | null = null
let pendingLearned: SerializedLearned | null = null

const post = (msg: WorkerResponse) => self.postMessage(msg)

function applyLearned(learned: SerializedLearned) {
  if (!converter) {
    pendingLearned = learned
    return
  }
  converter.learned = { segment: new Map(learned.segment), word: new Map(learned.word) }
}

async function load(url: string) {
  const started = performance.now()
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`词典下载失败（HTTP ${res.status}）`)
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let loaded = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    loaded += value.byteLength
    post({ type: 'progress', loaded, total })
  }
  let bytes = new Uint8Array(loaded)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.byteLength
  }
  // 服务器可能已经按 Content-Encoding 解压过，只在仍是 gzip 时自己解
  if (isGzip(bytes)) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))
    bytes = new Uint8Array(await new Response(stream).arrayBuffer())
  }
  converter = new Converter(parseDict(bytes.buffer as ArrayBuffer))
  if (pendingLearned) applyLearned(pendingLearned)
  post({ type: 'ready', ms: Math.round(performance.now() - started) })
}

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data
  if (msg.type === 'init') {
    pendingLearned = msg.learned
    load(msg.url).catch((err: unknown) => post({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
  } else if (msg.type === 'learned') {
    applyLearned(msg.learned)
  } else if (msg.type === 'convert') {
    if (!converter) return
    post({ type: 'result', id: msg.id, segments: converter.convert(msg.kana, msg.fixed) })
  }
}
