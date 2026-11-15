import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'

import { PREF_DASHBOARD_LANGUAGE, writeStringPref } from '../lib/prefs.js'
import { resources, type DashboardLanguage } from './resources.js'

const STORAGE_KEY = PREF_DASHBOARD_LANGUAGE
const DEFAULT_LANGUAGE: DashboardLanguage = 'en'

function readStoredLanguage(): DashboardLanguage {
  try {
    const stored = localStorage.getItem(STORAGE_KEY)
    if (stored === 'en' || stored === 'zh') return stored
  } catch {}
  return DEFAULT_LANGUAGE
}

void i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: readStoredLanguage(),
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: ['en', 'zh'],
    interpolation: { escapeValue: false },
    returnEmptyString: false,
  })

export function persistDashboardLanguage(language: DashboardLanguage): void {
  writeStringPref(STORAGE_KEY, language)
  document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en'
}

i18n.on('languageChanged', (language) => {
  persistDashboardLanguage(language === 'zh' ? 'zh' : 'en')
})

persistDashboardLanguage(readStoredLanguage())

export { i18n }
export type { DashboardLanguage }
