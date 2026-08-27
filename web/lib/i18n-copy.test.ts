import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const source = fs.readFileSync(new URL('./i18n.tsx', import.meta.url), 'utf8')
const sourceFile = ts.createSourceFile(
  'i18n.tsx',
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
)

function propertyName(property: ts.ObjectLiteralElementLike): string {
  if (!property.name) throw new Error('Every translation entry must have a name')
  if (ts.isStringLiteral(property.name) || ts.isIdentifier(property.name)) {
    return property.name.text
  }
  throw new Error(`Unsupported translation key syntax: ${property.name.getText(sourceFile)}`)
}

function translationObject(): ts.ObjectLiteralExpression {
  let result: ts.ObjectLiteralExpression | null = null
  const visit = (node: ts.Node) => {
    if (
      ts.isVariableDeclaration(node)
      && ts.isIdentifier(node.name)
      && node.name.text === 'translations'
      && node.initializer
      && ts.isObjectLiteralExpression(node.initializer)
    ) {
      result = node.initializer
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!result) throw new Error('Unable to locate translations object in i18n.tsx')
  return result
}

function getLocaleMap(locale: 'en' | 'zh-TW') {
  const localeProperty = translationObject().properties.find(
    (property) => propertyName(property) === locale,
  )
  if (!localeProperty || !ts.isPropertyAssignment(localeProperty)) {
    throw new Error(`Unable to locate ${locale} locale in i18n.tsx`)
  }
  if (!ts.isObjectLiteralExpression(localeProperty.initializer)) {
    throw new Error(`${locale} locale must be an object literal`)
  }

  const result = new Map<string, string>()
  for (const property of localeProperty.initializer.properties) {
    if (!ts.isPropertyAssignment(property)) {
      throw new Error(`${locale} translations must use plain property assignments`)
    }
    const key = propertyName(property)
    if (result.has(key)) throw new Error(`${locale} contains duplicate key: ${key}`)
    if (
      !ts.isStringLiteral(property.initializer)
      && !ts.isNoSubstitutionTemplateLiteral(property.initializer)
    ) {
      throw new Error(`${locale} key ${key} must contain a static string`)
    }
    result.set(key, property.initializer.text)
  }
  return result
}

function assertNoTextPattern(value: string, pattern: RegExp, key: string, locale: string) {
  if (pattern.test(value)) {
    assert.fail(`${locale} key '${key}' contains banned expression: ${pattern}`)
  }
}

test('i18n: en and zh-TW keys are 100% aligned', () => {
  const en = getLocaleMap('en')
  const zh = getLocaleMap('zh-TW')

  assert.equal(en.size, zh.size)
  assert.equal(en.size, 709, 'Review inventory changed; re-audit every added or removed key')
  assert.deepEqual(
    [...en.keys()].sort(),
    [...zh.keys()].sort(),
    'EN and zh-TW locale keys must be identical',
  )
})

test('i18n: zh-TW has no empty values for any key', () => {
  const zh = getLocaleMap('zh-TW')
  for (const [key, value] of zh) {
    assert.equal(typeof value, 'string')
    assert.equal(value.trim().length > 0, true, `zh-TW key ${key} is empty`)
  }
})

test('i18n: zh-TW wording avoids hard calque and approval-implying phrases', () => {
  const zh = getLocaleMap('zh-TW')
  const bannedPatterns: RegExp[] = [
    /OpenROAD\s*活動/i,
    /foundation/i,
    /snapshot/i,
    /批准|核准|核可|核認/i,
    /human-?approval/i,
    /\bgates?\b/i,
    /\bartifacts?\b/i,
    /\bmanifest\b/i,
    /\bscenario\b/i,
    /\brecovery action\b/i,
    /OpenAI-compatible/i,
    /timing intent/i,
    /protected smoke/i,
    /\bimage\b/i,
    /流水線/i,
  ]

  for (const [key, value] of zh) {
    for (const pattern of bannedPatterns) {
      assertNoTextPattern(value, pattern, key, 'zh-TW')
    }
  }
})

test('i18n: OpenROAD stage/mode keys should not reference removed approval label', () => {
  const en = getLocaleMap('en')
  const zh = getLocaleMap('zh-TW')

  for (const key of [...en.keys(), ...zh.keys()]) {
    assert.equal(key.includes('openroad.stage.approve'), false, `Unexpected openroad.stage.approve key: ${key}`)
    assert.equal(key.includes('openroad.mode.approve'), false, `Unexpected openroad.mode.approve key: ${key}`)
  }
})
