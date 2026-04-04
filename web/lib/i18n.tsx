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
    'home.badge': 'Open Source Chip Verification Pipeline',
    'home.title1': 'Learn. Verify.',
    'home.title2': 'Tape Out.',
    'home.description': 'AI-assisted chip verification platform. Auto-generate test plans, testbenches, and coverage reports from your RTL. Open source, pluggable LLM, education-first.',
    'home.cta.primary': 'Join the Waitlist',
    'home.cta.secondary': 'Try the Demo',
    'home.cta.github': 'Star on GitHub',
    'home.code.caption': 'AI-generated from: "16-bit barrel shifter with 2-stage pipeline"',

    // Landing - Pipeline
    'landing.pipeline.title': 'One Pipeline. Full Verification.',
    'landing.pipeline.subtitle': 'From RTL input to coverage report, every step visualized and AI-assisted.',
    'landing.pipeline.rtl': 'RTL Input',
    'landing.pipeline.lint': 'Lint',
    'landing.pipeline.testplan': 'Test Plan',
    'landing.pipeline.testbench': 'Testbench',
    'landing.pipeline.sim': 'Simulate',
    'landing.pipeline.coverage': 'Coverage',
    'landing.pipeline.debug': 'Debug',
    'landing.pipeline.synthesis': 'Synthesis',

    // Landing - Features
    'landing.features.title': 'What XylonStudio Does',
    'landing.f1.title': 'AI Test Plan Generation',
    'landing.f1.desc': 'Paste your RTL. AI analyzes ports, logic, and edge cases, then generates a structured verification plan. Learn what to test and why.',
    'landing.f2.title': 'Testbench Auto-Generation',
    'landing.f2.desc': 'AI writes SystemVerilog testbenches from your test plan. Verilator compiles and simulates automatically. Coverage too low? It iterates.',
    'landing.f3.title': 'Coverage-Driven Iteration',
    'landing.f3.desc': 'Real line, toggle, and branch coverage via Verilator. The pipeline loops until your coverage target is met or suggests what to test next.',
    'landing.f4.title': 'Debug Assistant',
    'landing.f4.desc': 'Simulation failed? AI explains what went wrong in plain language, highlights suspicious signals, and suggests fixes.',
    'landing.f5.title': 'RTL to Silicon',
    'landing.f5.desc': 'Synthesize with Yosys, place and route with OpenROAD. See your Verilog become a real chip layout targeting SkyWater 130nm.',
    'landing.f6.title': 'Pluggable LLM',
    'landing.f6.desc': 'Use Claude, GPT, DeepSeek, Qwen, or Ollama. Self-host for IP protection. Your model, your data, your choice.',

    // Landing - Audience
    'landing.audience.title': 'Built For',
    'landing.a1.title': 'Students & Professors',
    'landing.a1.desc': 'Free, open source. Learn verification methodology with AI guidance. Pipeline visualization makes every step clear.',
    'landing.a2.title': 'Junior DV Engineers',
    'landing.a2.desc': 'Accelerate testbench writing, understand coverage gaps, debug faster. On-premise deployment keeps your IP safe.',
    'landing.a3.title': 'FPGA Developers',
    'landing.a3.desc': 'Open-source toolchain, no license fees. CLI and API for automation. Community-driven and extensible.',

    // Landing - Open Source
    'landing.oss.title': 'Open Source. MIT License.',
    'landing.oss.desc': 'Core platform, pipeline engine, and all basic plugins are free and open source. Build on it, extend it, contribute back.',

    // Landing - Waitlist
    'landing.waitlist.title': 'Get Early Access',
    'landing.waitlist.desc': 'XylonStudio v2 is under active development. Join the waitlist to be the first to try it.',
    'landing.waitlist.placeholder': 'your@email.com',
    'landing.waitlist.btn': 'Join Waitlist',
    'landing.waitlist.privacy': 'No spam. Unsubscribe anytime.',
    'landing.waitlist.thanks': 'Thanks! We\'ll be in touch.',

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
    'home.badge': '開源晶片驗證流水線',
    'home.title1': '學習。驗證。',
    'home.title2': '投片。',
    'home.description': 'AI 輔助晶片驗證平台。從 RTL 自動生成測試計畫、測試平台與覆蓋率報告。開源、可插拔 LLM、教育優先。',
    'home.cta.primary': '加入候補名單',
    'home.cta.secondary': '試用 Demo',
    'home.cta.github': '在 GitHub 按星號',
    'home.code.caption': 'AI 生成自：「16 位元桶形移位器，2 級流水線」',

    // Landing - Pipeline
    'landing.pipeline.title': '一條流水線。完整驗證。',
    'landing.pipeline.subtitle': '從 RTL 輸入到覆蓋率報告，每一步皆可視化且由 AI 輔助。',
    'landing.pipeline.rtl': 'RTL 輸入',
    'landing.pipeline.lint': 'Lint 檢查',
    'landing.pipeline.testplan': '測試計畫',
    'landing.pipeline.testbench': '測試平台',
    'landing.pipeline.sim': '模擬',
    'landing.pipeline.coverage': '覆蓋率',
    'landing.pipeline.debug': '除錯',
    'landing.pipeline.synthesis': '合成',

    // Landing - Features
    'landing.features.title': 'XylonStudio 能做什麼',
    'landing.f1.title': 'AI 測試計畫生成',
    'landing.f1.desc': '貼上 RTL，AI 分析埠、邏輯與邊界情況，生成結構化驗證計畫。了解該測試什麼、為什麼。',
    'landing.f2.title': '測試平台自動生成',
    'landing.f2.desc': 'AI 從測試計畫撰寫 SystemVerilog 測試平台。Verilator 自動編譯與模擬。覆蓋率太低？自動迭代。',
    'landing.f3.title': '覆蓋率驅動迭代',
    'landing.f3.desc': '透過 Verilator 取得行覆蓋率、翻轉覆蓋率與分支覆蓋率。流水線持續迴圈直到達標，或建議下一步測試。',
    'landing.f4.title': '除錯助手',
    'landing.f4.desc': '模擬失敗？AI 用白話解釋問題、標示可疑訊號、建議修正方案。',
    'landing.f5.title': 'RTL 到矽晶',
    'landing.f5.desc': '用 Yosys 合成、OpenROAD 佈局繞線。看你的 Verilog 變成真正的晶片佈局，目標 SkyWater 130nm。',
    'landing.f6.title': '可插拔 LLM',
    'landing.f6.desc': '使用 Claude、GPT、DeepSeek、Qwen 或 Ollama。自架部署保護智慧財產。你的模型、你的資料、你的選擇。',

    // Landing - Audience
    'landing.audience.title': '為誰而建',
    'landing.a1.title': '學生與教授',
    'landing.a1.desc': '免費、開源。在 AI 引導下學習驗證方法論。流水線可視化讓每一步都清晰。',
    'landing.a2.title': '初階 DV 工程師',
    'landing.a2.desc': '加速測試平台撰寫、理解覆蓋率缺口、更快除錯。本地部署確保智財安全。',
    'landing.a3.title': 'FPGA 開發者',
    'landing.a3.desc': '開源工具鏈，無授權費。CLI 和 API 支援自動化。社群驅動且可擴展。',

    // Landing - Open Source
    'landing.oss.title': '開源。MIT 授權。',
    'landing.oss.desc': '核心平台、流水線引擎與所有基礎外掛皆免費開源。在其上建構、擴展、回饋社群。',

    // Landing - Waitlist
    'landing.waitlist.title': '搶先體驗',
    'landing.waitlist.desc': 'XylonStudio v2 正在積極開發中。加入候補名單，搶先試用。',
    'landing.waitlist.placeholder': 'your@email.com',
    'landing.waitlist.btn': '加入候補名單',
    'landing.waitlist.privacy': '不會發送垃圾信。隨時可退訂。',
    'landing.waitlist.thanks': '感謝！我們會盡快聯繫。',

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
