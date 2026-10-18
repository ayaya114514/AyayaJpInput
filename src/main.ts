import './style.css'
import dictUrl from '../dict/mozc.bin.gz?url'
import { Composer, PAGE_SIZE, wholeRow, type Key, type Live } from './ime/composer'
import { learnChoice, type LearnedSet, type Segment } from './ime/converter'
import type { SerializedLearned, WorkerRequest, WorkerResponse } from './ime/worker'

const editor = document.querySelector<HTMLDivElement>('#editor')!
const textarea = document.querySelector<HTMLTextAreaElement>('#text')!
const mirror = document.querySelector<HTMLDivElement>('#mirror')!
const candidatesEl = document.querySelector<HTMLDivElement>('#candidates')!
const statusEl = document.querySelector<HTMLSpanElement>('#status')!
const copyButton = document.querySelector<HTMLButtonElement>('#copy')!

const TEXT_KEY = 'ayaya-jp-input:text'
const LEARNED_KEY = 'ayaya-jp-input:learned'

// localStorage 在隐私模式等情况下可能抛错，读写都兜住
const storage = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key)
    } catch {
      return null
    }
  },
  set(key: string, value: string) {
    try {
      localStorage.setItem(key, value)
    } catch {
      // 存不下就算了，只影响下次打开
    }
  },
}

function loadLearned(): LearnedSet {
  try {
    const raw = JSON.parse(storage.get(LEARNED_KEY) ?? 'null') as SerializedLearned | null
    if (raw) return { segment: new Map(raw.segment), word: new Map(raw.word) }
  } catch {
    // 数据坏了就当没有
  }
  return { segment: new Map(), word: new Map() }
}

const learned = loadLearned()
const serializeLearned = (): SerializedLearned => ({ segment: [...learned.segment], word: [...learned.word] })

// ---- worker ----

const worker = new Worker(new URL('./ime/worker.ts', import.meta.url), { type: 'module' })
let ready = false
let nextId = 0
const pending = new Map<number, (segments: Segment[]) => void>()
const send = (msg: WorkerRequest) => worker.postMessage(msg)

worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
  const msg = event.data
  if (msg.type === 'progress') {
    const pct = msg.total ? Math.min(99, Math.floor((msg.loaded / msg.total) * 100)) : 0
    setStatus(`词典加载中 ${pct}%`)
  } else if (msg.type === 'ready') {
    ready = true
    setStatus('词典已就绪', true)
  } else if (msg.type === 'error') {
    setStatus(`词典加载失败：${msg.message}（仍可输入假名）`)
  } else if (msg.type === 'result') {
    pending.get(msg.id)?.(msg.segments)
    pending.delete(msg.id)
  }
}
worker.onerror = () => setStatus('词典加载失败（仍可输入假名）')
send({ type: 'init', url: new URL(dictUrl, location.href).href, learned: serializeLearned() })

function setStatus(text: string, done = false) {
  statusEl.textContent = text
  statusEl.classList.toggle('ready', done)
  if (done) {
    const link = document.createElement('a')
    link.href = `${import.meta.env.BASE_URL}LICENSE-mozc-dictionary.txt`
    link.textContent = 'Mozc'
    link.target = '_blank'
    link.rel = 'noopener'
    statusEl.textContent = '词典 '
    statusEl.append(link, ' 已就绪')
  }
}

// ---- 输入法 ----

// 开始输入时记下要替换的选区；未确定期间 textarea 的值不变，只在 mirror 里显示
let anchor = { start: 0, end: 0 }

function request(kana: string, fixed: number[]): Promise<Segment[]> {
  const id = ++nextId
  send({ type: 'convert', id, kana, fixed })
  return new Promise((resolve) => pending.set(id, resolve))
}

const composer = new Composer({
  convert(kana, fixed) {
    if (!ready) {
      statusEl.classList.add('flash')
      window.setTimeout(() => statusEl.classList.remove('flash'), 600)
      return null
    }
    return request(kana, fixed)
  },
  suggest(kana) {
    return ready ? request(kana, []) : null
  },
  start() {
    anchor = { start: textarea.selectionStart, end: textarea.selectionEnd }
  },
  commit(text) {
    if (text) insertText(text)
    else textarea.setSelectionRange(anchor.start, anchor.end)
  },
  learn(reading, candidate) {
    learnChoice(learned, reading, candidate)
    storage.set(LEARNED_KEY, JSON.stringify(serializeLearned()))
    send({ type: 'learned', learned: serializeLearned() })
  },
  changed: render,
})

function insertText(text: string) {
  // execCommand 能保留撤销历史，但要求 textarea 有焦点；失焦确定（点了别处）或不支持时用 setRangeText，
  // 不能在这里 focus()，否则点复制按钮时焦点会被抢回来
  const focused = document.activeElement === textarea
  if (focused) textarea.setSelectionRange(anchor.start, anchor.end)
  if (!focused || !document.execCommand('insertText', false, text)) {
    textarea.setRangeText(text, anchor.start, anchor.end, 'end')
    textarea.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

const COMPOSE_CHAR = /^[a-zA-Z\-,.?!'[\]~]$/

function keyFromEvent(e: KeyboardEvent): Key | null {
  const active = composer.active
  if (e.ctrlKey && !e.metaKey && !e.altKey && active) {
    if (e.key === 'j') return { type: 'hiragana' }
    if (e.key === 'k') return { type: 'katakana' }
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return null
  if (COMPOSE_CHAR.test(e.key)) return { type: 'char', ch: e.key }
  if (!active) return null
  // = 和 + 是同一个键，Shift 按没按都展开
  if (e.key === '=' || e.key === '+') return { type: 'expand' }
  if (/^[0-9]$/.test(e.key)) return { type: 'digit', n: Number(e.key) }
  switch (e.key) {
    case ' ':
      return { type: e.shiftKey ? 'shiftSpace' : 'space' }
    case 'Enter':
      return { type: 'enter' }
    case 'Tab':
      return { type: e.shiftKey ? 'shiftTab' : 'tab' }
    case 'Backspace':
      return { type: 'backspace' }
    case 'Escape':
      return { type: 'escape' }
    case 'ArrowLeft':
      return { type: e.shiftKey ? 'shiftLeft' : 'left' }
    case 'ArrowRight':
      return { type: e.shiftKey ? 'shiftRight' : 'right' }
    case 'ArrowUp':
      return { type: 'up' }
    case 'ArrowDown':
      return { type: 'down' }
    case 'F6':
      return { type: 'hiragana' }
    case 'F7':
      return { type: 'katakana' }
  }
  return null
}

textarea.addEventListener('keydown', (e) => {
  // 系统输入法正在组字时不插手
  if (e.isComposing || e.keyCode === 229) return
  const key = keyFromEvent(e)
  if (key && composer.handle(key)) {
    e.preventDefault()
    return
  }
  // 其他键（Tab、Cmd+A、符号……）先把未确定的内容确定掉，再交给浏览器
  if (composer.active && e.key.length === 1) composer.commitAll()
  else if (composer.active && (e.metaKey || e.ctrlKey || e.key === 'Tab')) composer.commitAll()
})

// 部分手机键盘 keydown 拿不到具体按键（keyCode 229），从 beforeinput 兜底
textarea.addEventListener('beforeinput', (e) => {
  if (e.isComposing) return
  let keys: Key[] | null = null
  if (e.inputType === 'insertText' && e.data) {
    const chars = [...e.data]
    if (chars.every((ch) => COMPOSE_CHAR.test(ch))) keys = chars.map((ch) => ({ type: 'char', ch }))
    else if (composer.active && e.data === ' ') keys = [{ type: 'space' }]
    else if (composer.active && /^[0-9]$/.test(e.data)) keys = [{ type: 'digit', n: Number(e.data) }]
  } else if (composer.active && e.inputType === 'insertLineBreak') {
    keys = [{ type: 'enter' }]
  } else if (composer.active && e.inputType === 'deleteContentBackward') {
    keys = [{ type: 'backspace' }]
  }
  if (keys) {
    e.preventDefault()
    for (const key of keys) composer.handle(key)
  } else if (composer.active) {
    composer.commitAll()
  }
})

textarea.addEventListener('pointerdown', () => composer.commitAll())
textarea.addEventListener('blur', () => composer.commitAll())
for (const type of ['paste', 'cut', 'drop']) textarea.addEventListener(type, () => composer.commitAll())

textarea.addEventListener('input', () => {
  storage.set(TEXT_KEY, textarea.value)
  render()
})

// ---- 渲染 ----

function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!)
}

function render() {
  const s = composer.state
  editor.classList.toggle('composing', s !== null)

  if (s) {
    const before = escapeHtml(textarea.value.slice(0, anchor.start))
    const after = escapeHtml(textarea.value.slice(anchor.end))
    let comp: string
    if (s.mode === 'input') {
      comp = `<span class="comp">${escapeHtml(composer.text)}</span><span class="caret"></span>`
    } else {
      comp = s.segments
        .map((seg, i) => {
          const cls = i === s.focus ? 'seg focus' : 'seg'
          return `<span class="${cls}" data-i="${i}">${escapeHtml(seg.candidates[seg.index].surface)}</span>`
        })
        .join('')
    }
    // 末尾补一个零宽字符，否则结尾换行在 div 里不占高度
    mirror.innerHTML = `${before}${comp}${after}​`
  } else {
    mirror.textContent = ''
  }

  autosize()
  renderCandidates()
}

function autosize() {
  textarea.style.height = 'auto'
  const height = Math.max(textarea.scrollHeight + 2, composer.active ? mirror.offsetHeight : 0)
  textarea.style.height = `${height}px`
}

function renderCandidates() {
  const s = composer.state
  if (s?.mode === 'input' && composer.live && composer.live.items.length > 0) {
    renderLive(composer.live)
    return
  }
  candidatesEl.className = 'candidates'
  if (!s || s.mode !== 'convert') {
    candidatesEl.hidden = true
    return
  }
  const seg = s.segments[s.focus]
  const page = Math.floor(seg.index / PAGE_SIZE)
  const pages = Math.ceil(seg.candidates.length / PAGE_SIZE)
  const items = seg.candidates.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  candidatesEl.innerHTML =
    items
      .map((c, i) => {
        const index = page * PAGE_SIZE + i
        const selected = index === seg.index
        return `<div class="cand${selected ? ' selected' : ''}" role="option" aria-selected="${selected}" data-index="${index}"><span class="num">${i + 1}</span>${escapeHtml(c.surface)}</div>`
      })
      .join('') + (pages > 1 ? `<div class="page">${page + 1} / ${pages}</div>` : '')
  candidatesEl.hidden = false

  // 放在当前文節下方，横向不超出编辑框
  const span = mirror.querySelector<HTMLSpanElement>('.seg.focus')
  if (!span) return
  placeCandidates(span)
}

/** 候选窗放在 span 下方，横向不超出编辑框 */
function placeCandidates(span: HTMLElement) {
  const rects = span.getClientRects()
  const rect = rects[rects.length - 1] ?? span.getBoundingClientRect()
  const box = editor.getBoundingClientRect()
  const width = candidatesEl.offsetWidth
  const left = Math.max(0, Math.min((rects[0] ?? rect).left - box.left, box.width - width))
  candidatesEl.style.left = `${left}px`
  candidatesEl.style.top = `${rect.bottom - box.top + 6}px`
}

// 窄屏少放几列，↑↓ 按行移动要和这里一致
const gridColumns = () => (editor.clientWidth < 480 ? 3 : 5)

/** 打字时的候选：默认一行横排，= 或点 ⌄ 展开成网格 */
function renderLive(live: Live) {
  const { items, highlight, expanded } = live
  const active = highlight >= 0
  const cell = (index: number, num: number | null) => {
    const c = items[index]
    const selected = index === highlight
    const label = num === null ? '' : `<span class="num">${num}</span>`
    return `<div class="cand${selected ? ' selected' : ''}" role="option" aria-selected="${selected}" data-index="${index}" title="${escapeHtml(c.surface)}">${label}${escapeHtml(c.surface)}</div>`
  }
  let html: string
  if (expanded) {
    composer.columns = gridColumns()
    candidatesEl.style.setProperty('--columns', String(composer.columns))
    html = `<div class="grid">${items.map((_, i) => cell(i, null)).join('')}</div>`
    // 整句候选通常比较长，覆盖多个文節时在网格里独占一行
    if (wholeRow(items)) html = html.replace('class="cand', 'class="cand whole')
  } else {
    const page = Math.floor(Math.max(0, highlight) / PAGE_SIZE)
    const indexes = items.map((_, i) => i).slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
    html = `<div class="row">${indexes.map((index, i) => cell(index, i + 1)).join('')}</div>`
  }
  if (expanded || items.length > PAGE_SIZE) {
    html += `<button type="button" class="expand" tabindex="-1" aria-label="${expanded ? '收起候选' : '展开候选'}" aria-expanded="${expanded}">${expanded ? '⌃' : '⌄'}</button>`
  }
  candidatesEl.innerHTML = html
  candidatesEl.className = `candidates live${expanded ? ' expanded' : ''}${active ? ' active' : ''}`
  candidatesEl.hidden = false

  const span = mirror.querySelector<HTMLSpanElement>('.comp')
  if (span) placeCandidates(span)
  // 高亮的候选滚到可见范围；不用 scrollIntoView，免得整页跟着滚
  const el = candidatesEl.querySelector<HTMLElement>('.cand.selected')
  const scroller = el?.parentElement
  if (el && scroller) {
    if (el.offsetLeft < scroller.scrollLeft) scroller.scrollLeft = el.offsetLeft
    else if (el.offsetLeft + el.offsetWidth > scroller.scrollLeft + scroller.clientWidth)
      scroller.scrollLeft = el.offsetLeft + el.offsetWidth - scroller.clientWidth
    if (el.offsetTop < scroller.scrollTop) scroller.scrollTop = el.offsetTop
    else if (el.offsetTop + el.offsetHeight > scroller.scrollTop + scroller.clientHeight)
      scroller.scrollTop = el.offsetTop + el.offsetHeight - scroller.clientHeight
  }
}

// 点候选：阻止默认行为保住 textarea 的焦点
candidatesEl.addEventListener('pointerdown', (e) => {
  e.preventDefault()
  const target = e.target as HTMLElement
  if (target.closest('.expand')) {
    composer.handle({ type: 'expand' })
    return
  }
  const item = target.closest<HTMLElement>('.cand')
  if (!item) return
  if (composer.state?.mode === 'input') composer.pick(Number(item.dataset.index))
  else composer.select(Number(item.dataset.index))
})

// ---- 复制 ----

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 非安全上下文或权限被拒时退回 execCommand
    const area = document.createElement('textarea')
    area.value = text
    area.setAttribute('readonly', '')
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.append(area)
    area.select()
    const ok = document.execCommand('copy')
    area.remove()
    return ok
  }
}

let copyTimer = 0
copyButton.addEventListener('click', async () => {
  composer.commitAll()
  const ok = textarea.value !== '' && (await copyText(textarea.value))
  copyButton.textContent = ok ? '已复制' : textarea.value === '' ? '没有内容' : '复制失败'
  copyButton.classList.toggle('done', ok)
  window.clearTimeout(copyTimer)
  copyTimer = window.setTimeout(() => {
    copyButton.textContent = '复制'
    copyButton.classList.remove('done')
  }, 1200)
})

window.addEventListener('resize', render)

textarea.value = storage.get(TEXT_KEY) ?? ''
textarea.setSelectionRange(textarea.value.length, textarea.value.length)
render()
