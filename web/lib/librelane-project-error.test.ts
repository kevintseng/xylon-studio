import assert from 'node:assert/strict'
import test from 'node:test'

import { localizeLibreLaneError } from './librelane-project-error.ts'

const translations: Record<string, string> = {
  'timing.project.idConflict': '這個本機專案 ID 已經存在。',
  'timing.project.idConflictRecovery': '請換一個本機專案 ID，再重新準備專案。',
  'timing.project.preflightBlocked': '專案 preflight 需要修正，OpenROAD 才能啟動。',
  'timing.project.preflightRecovery': '修正專案輸入後，再重新匯入整個 bundle。',
}

const translate = (key: string) => translations[key] ?? key

test('duplicate local project IDs get a precise Traditional Chinese next action', () => {
  assert.deepEqual(
    localizeLibreLaneError({
      code: 'ProjectImportInvalid',
      message: 'project_id already exists',
      recovery: 'retry',
    }, 'zh-TW', translate),
    {
      code: 'ProjectImportInvalid',
      message: translations['timing.project.idConflict'],
      recovery: translations['timing.project.idConflictRecovery'],
    },
  )
})

test('other project import failures keep the generic preflight guidance', () => {
  assert.deepEqual(
    localizeLibreLaneError({
      code: 'ProjectImportInvalid',
      message: 'clock period does not match the SDC',
      recovery: 'retry',
    }, 'zh-TW', translate),
    {
      code: 'ProjectImportInvalid',
      message: translations['timing.project.preflightBlocked'],
      recovery: translations['timing.project.preflightRecovery'],
    },
  )
})
