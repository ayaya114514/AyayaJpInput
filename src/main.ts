import './style.css'
import { hiraganaToKatakana, toHiragana } from './romaji'

const input = document.querySelector<HTMLTextAreaElement>('#romaji')!
const outputs = {
  hiragana: document.querySelector<HTMLOutputElement>('#hiragana')!,
  katakana: document.querySelector<HTMLOutputElement>('#katakana')!,
}
const copyButtons = document.querySelectorAll<HTMLButtonElement>('.copy')

function render() {
  const hiragana = toHiragana(input.value)
  outputs.hiragana.textContent = hiragana
  outputs.katakana.textContent = hiraganaToKatakana(hiragana)
  copyButtons.forEach((btn) => (btn.disabled = hiragana === ''))
}

// 输入框随内容长高，避免出现内部滚动条
function autosize() {
  input.style.height = 'auto'
  input.style.height = `${input.scrollHeight}px`
}

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

const resetTimers = new WeakMap<HTMLButtonElement, number>()

copyButtons.forEach((btn) => {
  btn.addEventListener('click', async () => {
    const target = outputs[btn.dataset.target as keyof typeof outputs]
    const ok = await copyText(target.textContent ?? '')
    btn.textContent = ok ? '已复制' : '复制失败'
    btn.classList.toggle('done', ok)
    window.clearTimeout(resetTimers.get(btn))
    resetTimers.set(
      btn,
      window.setTimeout(() => {
        btn.textContent = '复制'
        btn.classList.remove('done')
      }, 1200),
    )
  })
})

input.addEventListener('input', () => {
  render()
  autosize()
})

render()
autosize()
