'use client'

import { useI18n } from '@/lib/i18n'

export function LanguageSwitcher() {
  const { locale, setLocale, t } = useI18n()
  const label = locale === 'en'
    ? t('language.switchToChinese')
    : t('language.switchToEnglish')

  return (
    <button
      onClick={() => setLocale(locale === 'en' ? 'zh-TW' : 'en')}
      className="px-2 py-1 rounded-md text-xs font-medium text-slate-400 hover:text-slate-100 hover:bg-slate-800 transition-all border border-slate-700"
      title={label}
      aria-label={label}
    >
      {locale === 'en' ? '中文' : 'EN'}
    </button>
  )
}
