// 罗马音 → 假名。规则按常见 IME（Google / MS-IME）的罗马字表，
// 同时兼容 Hepburn（shi/chi/tsu/fu/ji）和訓令式（si/ti/tu/hu/zi）。

const VOWELS = 'aiueo'

// 每组 5 个依次对应 a i u e o；null 表示该组没有这个音。
const ROWS: Record<string, (string | null)[]> = {
  '': ['あ', 'い', 'う', 'え', 'お'],
  k: ['か', 'き', 'く', 'け', 'こ'],
  ky: ['きゃ', 'きぃ', 'きゅ', 'きぇ', 'きょ'],
  kw: ['くぁ', 'くぃ', 'くぅ', 'くぇ', 'くぉ'],
  q: ['くぁ', 'くぃ', 'く', 'くぇ', 'くぉ'],
  c: ['か', 'し', 'く', 'せ', 'こ'],
  g: ['が', 'ぎ', 'ぐ', 'げ', 'ご'],
  gy: ['ぎゃ', 'ぎぃ', 'ぎゅ', 'ぎぇ', 'ぎょ'],
  gw: ['ぐぁ', 'ぐぃ', 'ぐぅ', 'ぐぇ', 'ぐぉ'],
  s: ['さ', 'し', 'す', 'せ', 'そ'],
  sh: ['しゃ', 'し', 'しゅ', 'しぇ', 'しょ'],
  sy: ['しゃ', 'しぃ', 'しゅ', 'しぇ', 'しょ'],
  z: ['ざ', 'じ', 'ず', 'ぜ', 'ぞ'],
  zy: ['じゃ', 'じぃ', 'じゅ', 'じぇ', 'じょ'],
  j: ['じゃ', 'じ', 'じゅ', 'じぇ', 'じょ'],
  jy: ['じゃ', 'じぃ', 'じゅ', 'じぇ', 'じょ'],
  t: ['た', 'ち', 'つ', 'て', 'と'],
  ty: ['ちゃ', 'ちぃ', 'ちゅ', 'ちぇ', 'ちょ'],
  ch: ['ちゃ', 'ち', 'ちゅ', 'ちぇ', 'ちょ'],
  cy: ['ちゃ', 'ちぃ', 'ちゅ', 'ちぇ', 'ちょ'],
  ts: ['つぁ', 'つぃ', 'つ', 'つぇ', 'つぉ'],
  th: ['てゃ', 'てぃ', 'てゅ', 'てぇ', 'てょ'],
  tw: ['とぁ', 'とぃ', 'とぅ', 'とぇ', 'とぉ'],
  d: ['だ', 'ぢ', 'づ', 'で', 'ど'],
  dy: ['ぢゃ', 'ぢぃ', 'ぢゅ', 'ぢぇ', 'ぢょ'],
  dh: ['でゃ', 'でぃ', 'でゅ', 'でぇ', 'でょ'],
  dw: ['どぁ', 'どぃ', 'どぅ', 'どぇ', 'どぉ'],
  n: ['な', 'に', 'ぬ', 'ね', 'の'],
  ny: ['にゃ', 'にぃ', 'にゅ', 'にぇ', 'にょ'],
  h: ['は', 'ひ', 'ふ', 'へ', 'ほ'],
  hy: ['ひゃ', 'ひぃ', 'ひゅ', 'ひぇ', 'ひょ'],
  f: ['ふぁ', 'ふぃ', 'ふ', 'ふぇ', 'ふぉ'],
  fy: ['ふゃ', 'ふぃ', 'ふゅ', 'ふぇ', 'ふょ'],
  b: ['ば', 'び', 'ぶ', 'べ', 'ぼ'],
  by: ['びゃ', 'びぃ', 'びゅ', 'びぇ', 'びょ'],
  p: ['ぱ', 'ぴ', 'ぷ', 'ぺ', 'ぽ'],
  py: ['ぴゃ', 'ぴぃ', 'ぴゅ', 'ぴぇ', 'ぴょ'],
  v: ['ゔぁ', 'ゔぃ', 'ゔ', 'ゔぇ', 'ゔぉ'],
  vy: ['ゔゃ', 'ゔぃ', 'ゔゅ', 'ゔぇ', 'ゔょ'],
  m: ['ま', 'み', 'む', 'め', 'も'],
  my: ['みゃ', 'みぃ', 'みゅ', 'みぇ', 'みょ'],
  y: ['や', 'い', 'ゆ', 'いぇ', 'よ'],
  r: ['ら', 'り', 'る', 'れ', 'ろ'],
  ry: ['りゃ', 'りぃ', 'りゅ', 'りぇ', 'りょ'],
  w: ['わ', 'うぃ', 'う', 'うぇ', 'を'],
  wh: ['うぁ', 'うぃ', 'う', 'うぇ', 'うぉ'],
  x: ['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ'],
  l: ['ぁ', 'ぃ', 'ぅ', 'ぇ', 'ぉ'],
  xy: ['ゃ', null, 'ゅ', null, 'ょ'],
  ly: ['ゃ', null, 'ゅ', null, 'ょ'],
}

const EXTRA: Record<string, string> = {
  wyi: 'ゐ',
  wye: 'ゑ',
  xtu: 'っ',
  ltu: 'っ',
  xtsu: 'っ',
  ltsu: 'っ',
  xwa: 'ゎ',
  lwa: 'ゎ',
  xka: 'ゕ',
  lka: 'ゕ',
  xke: 'ゖ',
  lke: 'ゖ',
  xn: 'ん',
  '-': 'ー',
  ',': '、',
  '.': '。',
  '?': '？',
  '!': '！',
  '[': '「',
  ']': '」',
  '~': '〜',
}

const TABLE = new Map<string, string>()
for (const [head, kana] of Object.entries(ROWS)) {
  kana.forEach((k, i) => {
    if (k) TABLE.set(head + VOWELS[i], k)
  })
}
for (const [key, kana] of Object.entries(EXTRA)) TABLE.set(key, kana)

const MAX_KEY = Math.max(...[...TABLE.keys()].map((k) => k.length))
const CONSONANTS = 'bcdfghjklmpqrstvwxyz'

// 到结尾时 ch 是 ''，而 'aiueo'.includes('') 恒为 true，必须单独排除
const isVowel = (ch: string) => ch !== '' && VOWELS.includes(ch)
const isConsonant = (ch: string) => ch !== '' && CONSONANTS.includes(ch)

/** 罗马音 → 平假名。无法识别的字符原样保留。 */
export function toHiragana(input: string): string {
  const src = input.toLowerCase()
  let out = ''
  let i = 0

  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1] ?? ''

    if (c === 'n') {
      // n' 显式拨音：kan'i → かんい
      if (next === "'") {
        out += 'ん'
        i += 2
        continue
      }
      // nn：后面紧跟元音 / y 时只吃一个 n，让第二个 n 开始下一个音节
      // （onna → おんな，konnichiwa → こんにちわ）；否则 nn 整体是ん（sannpo → さんぽ）
      if (next === 'n') {
        const after = src[i + 2] ?? ''
        const startsSyllable = isVowel(after) || after === 'y'
        out += 'ん'
        i += startsSyllable ? 1 : 2
        continue
      }
      // n 后面不是元音 / y（或已到结尾）→ ん
      if (!isVowel(next) && next !== 'y') {
        out += 'ん'
        i += 1
        continue
      }
    }

    // Hepburn 写法 m + b/m/p 中的 m 读ん：shimbun → しんぶん；mm 交给促音规则
    if (c === 'm' && (next === 'b' || next === 'p')) {
      out += 'ん'
      i += 1
      continue
    }

    // 促音：双写辅音（kka → っか），以及 tch（matcha → まっちゃ）
    if (isConsonant(c) && (next === c || (c === 't' && src.startsWith('ch', i + 1)))) {
      out += 'っ'
      i += 1
      continue
    }

    let matched = false
    for (let len = Math.min(MAX_KEY, src.length - i); len > 0; len--) {
      const kana = TABLE.get(src.slice(i, i + len))
      if (kana) {
        out += kana
        i += len
        matched = true
        break
      }
    }
    if (!matched) {
      out += input[i]
      i += 1
    }
  }

  return out
}

/** 平假名 → 片假名（ぁ–ゖ 整体平移，ー 等其他字符不变）。 */
export function hiraganaToKatakana(text: string): string {
  return text.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60))
}

export function toKatakana(input: string): string {
  return hiraganaToKatakana(toHiragana(input))
}
