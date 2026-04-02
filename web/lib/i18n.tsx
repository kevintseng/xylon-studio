'use client'

import { createContext, useContext, useState, useCallback, useEffect, ReactNode } from 'react'

export type Locale = 'en' | 'zh-TW'

const translations: Record<Locale, Record<string, string>> = {
  en: {
    // Nav
    'nav.home': 'Home',
    'nav.design': 'Design',
    'nav.verify': 'Verify',
    'nav.history': 'History',

    // Home
    'home.badge': 'AI-Powered EDA Platform',
    'home.title1': 'Design Chips',
    'home.title2': 'With Words',
    'home.description': 'Transform natural language specifications into production-ready, lint-clean Verilog RTL. Powered by self-hosted LLM.',
    'home.cta.design': 'Start Designing',
    'home.cta.verify': 'Verify RTL',
    'home.code.caption': 'AI-generated from: "16-bit barrel shifter with 2-stage pipeline"',

    // Design
    'design.title': 'Design Dragon',
    'design.subtitle': 'Generate synthesizable Verilog RTL from natural language',
    'design.quickstart': 'Quick start:',
    'design.label.description': 'Design Description',
    'design.label.targetFreq': 'Target Frequency',
    'design.label.moduleName': 'Module Name',
    'design.label.maxArea': 'Max Area',
    'design.label.maxPower': 'Max Power',
    'design.placeholder.description': 'e.g., 8-bit ripple carry adder with overflow detection',
    'design.placeholder.targetFreq': 'e.g., 2 GHz, 100 MHz',
    'design.placeholder.moduleName': 'Optional — auto-generated if empty',
    'design.placeholder.maxArea': 'e.g., 10000 um²',
    'design.placeholder.maxPower': 'e.g., 15 mW',
    'design.btn.generate': 'Generate RTL',
    'design.btn.generating': 'Generating RTL...',
    'design.loading': 'LLM is generating your Verilog code. This typically takes 30-60 seconds.',
    'design.result.title': 'RTL Generated',
    'design.result.module': 'Module',
    'design.result.loc': 'Lines of Code',
    'design.result.quality': 'Quality Score',
    'design.result.lint': 'Lint Warnings',
    'design.result.code': 'Generated Code:',
    'design.result.verify': 'Verify This RTL',
    'design.result.saved': 'Saved to history',
    'design.optional': '(optional)',

    // Verify
    'verify.title': 'Verification Dragon',
    'verify.subtitle': 'Generate testbenches and verify RTL functionality',
    'verify.label.module': 'Module Name',
    'verify.label.code': 'Verilog RTL Code',
    'verify.placeholder.module': 'e.g., adder_8bit',
    'verify.placeholder.code': 'Paste your Verilog RTL code here...',
    'verify.btn.verify': 'Verify RTL',
    'verify.btn.verifying': 'Generating Testbench & Verifying...',
    'verify.loading': 'LLM is generating testbenches and running simulation. This typically takes 60-90 seconds.',
    'verify.result.title': 'Verification Results',
    'verify.result.passed': 'Tests Passed',
    'verify.result.failed': 'Tests Failed',
    'verify.result.coverage': 'Code Coverage',
    'verify.result.status': 'Overall Status',
    'verify.result.allPassed': 'All Tests Passed',
    'verify.result.someFailed': 'Test(s) Failed',
    'verify.result.skipped': 'Simulation skipped (no Docker sandbox)',
    'verify.result.errors': 'Errors',
    'verify.result.testbench': 'Testbench:',
    'verify.result.waveform': 'Waveform:',

    // History
    'history.title': 'History',
    'history.subtitle': 'View past design and verification results',
    'history.empty': 'No history yet. Generate a design or run verification to get started.',
    'history.type.design': 'Design',
    'history.type.verification': 'Verification',
    'history.quality': 'Quality',
    'history.tests': 'Tests',
    'history.delete': 'Delete',
    'history.deleteAll': 'Clear All',
    'history.confirmDelete': 'Are you sure?',
    'history.load': 'Load',
    'history.workspace': 'Workspace',
    'history.allWorkspaces': 'All Workspaces',

    // Workspace
    'workspace.default': 'Default Workspace',
    'workspace.new': 'New Workspace',
    'workspace.rename': 'Rename',
    'workspace.delete': 'Delete',
    'workspace.placeholder': 'Workspace name...',

    // Common
    'common.error': 'Error',
    'common.required': '*',
    'common.cancel': 'Cancel',
    'common.save': 'Save',
    'common.close': 'Close',

    // Footer
    'footer.copyright': '© 2026 XylonStudio. Licensed under MIT License.',
    'footer.reportIssue': 'Report Issue',
    'footer.contact': 'Contact',
  },
  'zh-TW': {
    // Nav
    'nav.home': '首頁',
    'nav.design': '設計',
    'nav.verify': '驗證',
    'nav.history': '歷史紀錄',

    // Home
    'home.badge': 'AI 驅動 EDA 平台',
    'home.title1': '用語言',
    'home.title2': '設計晶片',
    'home.description': '將自然語言規格轉換為可量產、無 lint 警告的 Verilog RTL。由自建 LLM 驅動。',
    'home.cta.design': '開始設計',
    'home.cta.verify': '驗證 RTL',
    'home.code.caption': 'AI 生成自：「16 位元桶形移位器，2 級流水線」',

    // Design
    'design.title': '設計龍',
    'design.subtitle': '從自然語言生成可合成的 Verilog RTL',
    'design.quickstart': '快速開始：',
    'design.label.description': '設計描述',
    'design.label.targetFreq': '目標頻率',
    'design.label.moduleName': '模組名稱',
    'design.label.maxArea': '最大面積',
    'design.label.maxPower': '最大功耗',
    'design.placeholder.description': '例：8 位元漣波進位加法器，含溢位偵測',
    'design.placeholder.targetFreq': '例：2 GHz、100 MHz',
    'design.placeholder.moduleName': '選填 — 留空自動生成',
    'design.placeholder.maxArea': '例：10000 um²',
    'design.placeholder.maxPower': '例：15 mW',
    'design.btn.generate': '生成 RTL',
    'design.btn.generating': '正在生成 RTL...',
    'design.loading': 'LLM 正在生成 Verilog 程式碼，通常需要 30-60 秒。',
    'design.result.title': 'RTL 已生成',
    'design.result.module': '模組',
    'design.result.loc': '程式碼行數',
    'design.result.quality': '品質分數',
    'design.result.lint': 'Lint 警告',
    'design.result.code': '生成的程式碼：',
    'design.result.verify': '驗證此 RTL',
    'design.result.saved': '已儲存至歷史紀錄',
    'design.optional': '（選填）',

    // Verify
    'verify.title': '驗證龍',
    'verify.subtitle': '生成測試平台並驗證 RTL 功能',
    'verify.label.module': '模組名稱',
    'verify.label.code': 'Verilog RTL 程式碼',
    'verify.placeholder.module': '例：adder_8bit',
    'verify.placeholder.code': '在此貼上 Verilog RTL 程式碼...',
    'verify.btn.verify': '驗證 RTL',
    'verify.btn.verifying': '正在生成測試平台並驗證...',
    'verify.loading': 'LLM 正在生成測試平台並執行模擬，通常需要 60-90 秒。',
    'verify.result.title': '驗證結果',
    'verify.result.passed': '通過測試',
    'verify.result.failed': '失敗測試',
    'verify.result.coverage': '程式碼覆蓋率',
    'verify.result.status': '整體狀態',
    'verify.result.allPassed': '全部測試通過',
    'verify.result.someFailed': '個測試失敗',
    'verify.result.skipped': '模擬已跳過（無 Docker 沙箱）',
    'verify.result.errors': '錯誤',
    'verify.result.testbench': '測試平台：',
    'verify.result.waveform': '波形檔：',

    // History
    'history.title': '歷史紀錄',
    'history.subtitle': '查看過去的設計與驗證結果',
    'history.empty': '尚無紀錄。開始生成設計或執行驗證吧。',
    'history.type.design': '設計',
    'history.type.verification': '驗證',
    'history.quality': '品質',
    'history.tests': '測試',
    'history.delete': '刪除',
    'history.deleteAll': '清除全部',
    'history.confirmDelete': '確定要刪除嗎？',
    'history.load': '載入',
    'history.workspace': '工作區',
    'history.allWorkspaces': '所有工作區',

    // Workspace
    'workspace.default': '預設工作區',
    'workspace.new': '新增工作區',
    'workspace.rename': '重新命名',
    'workspace.delete': '刪除',
    'workspace.placeholder': '工作區名稱...',

    // Common
    'common.error': '錯誤',
    'common.required': '*',
    'common.cancel': '取消',
    'common.save': '儲存',
    'common.close': '關閉',

    // Footer
    'footer.copyright': '© 2026 XylonStudio. MIT 授權。',
    'footer.reportIssue': '回報問題',
    'footer.contact': '聯絡我們',
  },
}

interface I18nContextType {
  locale: Locale
  setLocale: (locale: Locale) => void
  t: (key: string) => string
}

const I18nContext = createContext<I18nContextType>({
  locale: 'zh-TW',
  setLocale: () => {},
  t: (key) => key,
})

const LOCALE_KEY = 'xylon-locale'

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('en')

  useEffect(() => {
    const saved = localStorage.getItem(LOCALE_KEY) as Locale | null
    if (saved && (saved === 'en' || saved === 'zh-TW')) {
      setLocaleState(saved)
    } else {
      const browserLang = navigator.language || 'en'
      if (browserLang.startsWith('zh')) {
        setLocaleState('zh-TW')
      }
    }
  }, [])

  useEffect(() => {
    document.documentElement.lang = locale
  }, [locale])

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l)
    localStorage.setItem(LOCALE_KEY, l)
  }, [])

  const t = useCallback((key: string): string => {
    return translations[locale][key] || translations['en'][key] || key
  }, [locale])

  return (
    <I18nContext.Provider value={{ locale, setLocale, t }}>
      {children}
    </I18nContext.Provider>
  )
}

export function useI18n() {
  return useContext(I18nContext)
}
