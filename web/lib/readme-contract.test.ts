import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8')
const readmeZhTw = readFileSync(new URL('../../README.zh-TW.md', import.meta.url), 'utf8')

function normalize(value: string) {
  return value.toLowerCase().replace(/\s+/g, ' ')
}

function assertIncludesAnchors(source: string, anchors: string[], label: string) {
  for (const anchor of anchors) {
    assert.equal(
      normalize(source).includes(normalize(anchor)),
      true,
      `${label} must include anchor: ${anchor}`,
    )
  }
}

function assertExcludesPatterns(source: string, patterns: RegExp[], label: string) {
  for (const pattern of patterns) {
    assert.equal(pattern.test(source), false, `${label} contains banned claim: ${pattern}`)
  }
}

test('README documents the bounded setup-timing journey and its unsupported boundaries', () => {
  assertIncludesAnchors(
    readme,
    [
      'Setup-timing assistant',
      'real RTL and SDC',
      'built-in `sky130hd`',
      'WNS, TNS, and the worst setup path',
      'PLACE_DENSITY 0.60 → 0.65',
      'Remote BYOK endpoints or stored API keys',
      'not physical signoff or tape-out readiness',
    ],
    'README.md',
  )
  assertIncludesAnchors(
    readmeZhTw,
    [
      'Setup 時序助理',
      '真實 RTL、SDC',
      '內建 `sky130hd`',
      'WNS、TNS 與最差 setup 路徑',
      'PLACE_DENSITY 0.60 → 0.65',
      '遠端 BYOK 服務網址或保存 API key',
      '不等於 timing closure',
      '不代表實體設計',
      '可以投片',
    ],
    'README.zh-TW.md',
  )
})

test('README truthfulness contract rejects old dragon and fake-complete positioning', () => {
  assertExcludesPatterns(
    readme,
    [
      /\bdragon\b/i,
      /\bfake[- ]?complete\b/i,
      /\btape-?out-?ready\b/i,
      /does not yet import a complete RTL\/SDC\/PDK design/i,
      /next product slice/i,
    ],
    'README.md',
  )
  assertExcludesPatterns(
    readmeZhTw,
    [
      /OpenROAD\s*活動/i,
      /dragon/i,
      /fake[- ]?complete/i,
      /tape-?out-?ready/i,
      /還不能匯入完整的 RTL／SDC／PDK 設計/i,
      /下一個產品切片/i,
    ],
    'README.zh-TW.md',
  )
})
