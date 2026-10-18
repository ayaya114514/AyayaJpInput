// 平假名 / 片假名框：罗马音就地转成假名，不经过输入法。
// 当前这一段的罗马音记在 buffer 里，每打一个字整段重新转换，
// 所以 n → ん → な、konnichiha 这种要看后文的写法也能转对。

/** 会被当成罗马音的字符（和输入法框一致） */
export const KANA_CHAR = /^[a-zA-Z\-,.?!'[\]~]$/

export interface Run {
  buffer: string
  display: string
}

export function typeChars(buffer: string, chars: string, convert: (romaji: string) => string): Run {
  const next = buffer + chars
  return { buffer: next, display: convert(next) }
}

/** 删掉最后一个显示出来的字；剩下的部分直接以假名形式留在 buffer 里 */
export function backspace(display: string, convert: (romaji: string) => string): Run {
  const next = display.slice(0, -1)
  return { buffer: next, display: convert(next) }
}

/** 给 textarea 接上就地转换；内容变化照常触发 input 事件 */
export function attachKanaInput(el: HTMLTextAreaElement, convert: (romaji: string) => string) {
  // 正在打的这一段：从 start 开始，当前显示为 run.display
  let run: (Run & { start: number }) | null = null
  let applying = false

  // 光标还停在这一段末尾、内容也没被改过，才接着拼
  const valid = () =>
    run !== null &&
    el.selectionStart === el.selectionEnd &&
    el.selectionStart === run.start + run.display.length &&
    el.value.slice(run.start, el.selectionStart) === run.display

  function replace(from: number, to: number, text: string) {
    // execCommand 能保留撤销历史；不支持时用 setRangeText
    el.setSelectionRange(from, to)
    applying = true
    const ok = text ? document.execCommand('insertText', false, text) : document.execCommand('delete')
    applying = false
    if (!ok) {
      el.setRangeText(text, from, to, 'end')
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }

  el.addEventListener('beforeinput', (e) => {
    if (applying || e.isComposing) return
    if (e.inputType === 'insertText' && e.data && [...e.data].every((ch) => KANA_CHAR.test(ch))) {
      e.preventDefault()
      let from = el.selectionStart
      const to = el.selectionEnd
      let buffer = ''
      if (valid()) {
        from = run!.start
        buffer = run!.buffer
      }
      const next = typeChars(buffer, e.data, convert)
      replace(from, to, next.display)
      run = { ...next, start: from }
    } else if (e.inputType === 'deleteContentBackward' && valid() && run!.display) {
      e.preventDefault()
      const next = backspace(run!.display, convert)
      replace(run!.start, run!.start + run!.display.length, next.display)
      run = next.display ? { ...next, start: run!.start } : null
    } else {
      run = null
    }
  })

  for (const type of ['blur', 'pointerdown']) el.addEventListener(type, () => (run = null))
}
