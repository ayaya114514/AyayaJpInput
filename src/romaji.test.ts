import { describe, expect, it } from 'vitest'
import { hiraganaToKatakana, toHiragana, toKatakana } from './romaji'

const cases = (pairs: [string, string][]) => {
  for (const [romaji, kana] of pairs) {
    it(`${romaji} → ${kana}`, () => expect(toHiragana(romaji)).toBe(kana))
  }
}

describe('基本五十音', () => {
  cases([
    ['aiueo', 'あいうえお'],
    ['kakikukeko', 'かきくけこ'],
    ['sashisuseso', 'さしすせそ'],
    ['tachitsuteto', 'たちつてと'],
    ['naninuneno', 'なにぬねの'],
    ['hahifuheho', 'はひふへほ'],
    ['mamimumemo', 'まみむめも'],
    ['yayuyo', 'やゆよ'],
    ['rarirurero', 'らりるれろ'],
    ['wawo', 'わを'],
    ['gagigugego', 'がぎぐげご'],
    ['zajizuzezo', 'ざじずぜぞ'],
    ['dadidudedo', 'だぢづでど'],
    ['babibubebo', 'ばびぶべぼ'],
    ['papipupepo', 'ぱぴぷぺぽ'],
  ])
})

describe('訓令式 / 日本式写法', () => {
  cases([
    ['si', 'し'],
    ['ti', 'ち'],
    ['tu', 'つ'],
    ['hu', 'ふ'],
    ['zi', 'じ'],
    ['sya', 'しゃ'],
    ['tyo', 'ちょ'],
    ['zyu', 'じゅ'],
  ])
})

describe('拗音', () => {
  cases([
    ['kyakyukyo', 'きゃきゅきょ'],
    ['shashusho', 'しゃしゅしょ'],
    ['chachucho', 'ちゃちゅちょ'],
    ['nyanyunyo', 'にゃにゅにょ'],
    ['hyahyuhyo', 'ひゃひゅひょ'],
    ['myamyumyo', 'みゃみゅみょ'],
    ['ryaryuryo', 'りゃりゅりょ'],
    ['gyagyugyo', 'ぎゃぎゅぎょ'],
    ['jajujo', 'じゃじゅじょ'],
    ['jyajyujyo', 'じゃじゅじょ'],
    ['byabyubyo', 'びゃびゅびょ'],
    ['pyapyupyo', 'ぴゃぴゅぴょ'],
  ])
})

describe('促音', () => {
  cases([
    ['kitte', 'きって'],
    ['gakkou', 'がっこう'],
    ['zasshi', 'ざっし'],
    ['matcha', 'まっちゃ'],
    ['kocchi', 'こっち'],
    ['ippai', 'いっぱい'],
    ['xtu', 'っ'],
    ['ltsu', 'っ'],
  ])
})

describe('拨音 ん', () => {
  cases([
    ['hon', 'ほん'],
    ['kanji', 'かんじ'],
    ['onna', 'おんな'],
    ['minna', 'みんな'],
    ['konnichiwa', 'こんにちわ'],
    ['konnnichiha', 'こんにちは'],
    ['sannpo', 'さんぽ'],
    ['nn', 'ん'],
    ["kan'i", 'かんい'],
    ["gen'in", 'げんいん'],
    ['kani', 'かに'],
    ['konnyaku', 'こんにゃく'],
    ['shimbun', 'しんぶん'],
    ['tempura', 'てんぷら'],
    ['xn', 'ん'],
  ])
})

describe('外来语音', () => {
  cases([
    ['fa', 'ふぁ'],
    ['fi', 'ふぃ'],
    ['fe', 'ふぇ'],
    ['fo', 'ふぉ'],
    ['she', 'しぇ'],
    ['che', 'ちぇ'],
    ['je', 'じぇ'],
    ['thi', 'てぃ'],
    ['dhi', 'でぃ'],
    ['twu', 'とぅ'],
    ['dwu', 'どぅ'],
    ['tsa', 'つぁ'],
    ['wi', 'うぃ'],
    ['we', 'うぇ'],
    ['ye', 'いぇ'],
    ['vu', 'ゔ'],
    ['va', 'ゔぁ'],
  ])
})

describe('小写假名', () => {
  cases([
    ['xa', 'ぁ'],
    ['li', 'ぃ'],
    ['xya', 'ゃ'],
    ['lyo', 'ょ'],
    ['xwa', 'ゎ'],
    ['xka', 'ゕ'],
  ])
})

describe('长音、标点和其他字符', () => {
  cases([
    ['ra-men', 'らーめん'],
    ['hai, sou desu.', 'はい、 そう です。'],
    ['nani?', 'なに？'],
    ['[sou]', '「そう」'],
    ['abc123', 'あbc123'],
    ['k', 'k'],
    ['', ''],
    ['TOKYO', 'ときょ'],
    ['Toukyou', 'とうきょう'],
    ['hi\nmi', 'ひ\nみ'],
  ])
})

describe('片假名', () => {
  it('与平假名一一对应', () => {
    expect(toKatakana('ko-hi-')).toBe('コーヒー')
    expect(toKatakana('pa-thi-')).toBe('パーティー')
    expect(toKatakana('vaiorin')).toBe('ヴァイオリン')
    expect(toKatakana('konpyu-ta-')).toBe('コンピューター')
    expect(toKatakana('wyiwye')).toBe('ヰヱ')
    expect(toKatakana('xkaxke')).toBe('ヵヶ')
    expect(toKatakana('xtsu')).toBe('ッ')
  })

  it('覆盖整个平假名区间', () => {
    for (let code = 0x3041; code <= 0x3096; code++) {
      expect(hiraganaToKatakana(String.fromCharCode(code)).charCodeAt(0)).toBe(code + 0x60)
    }
  })
})
