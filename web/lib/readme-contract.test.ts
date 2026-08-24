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

test('README documents a bounded OpenROAD execution record instead of a full timing journey', () => {
  assertIncludesAnchors(
    readme,
    [
      'OpenROAD',
      'does not yet import a complete RTL/SDC/PDK design',
      'does not yet',
      'worst timing path',
      'timing improvement',
    ],
    'README.md',
  )
  assertIncludesAnchors(
    readmeZhTw,
    [
      'OpenROAD',
      '還不能匯入完整的 RTL／SDC／PDK 設計',
      '最差時序路徑',
      '時序改善',
      '尚未可用',
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
    ],
    'README.zh-TW.md',
  )
})
