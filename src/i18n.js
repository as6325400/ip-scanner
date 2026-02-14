import { reactive } from 'vue'
import en from './locales/en.json'
import zhTW from './locales/zh-TW.json'

const messages = { en, 'zh-TW': zhTW }
const state = reactive({ locale: 'en' })

function findLocale(lang) {
  if (!lang) return null
  const normalized = lang.replace('_', '-')
  const keys = Object.keys(messages)

  const exact = keys.find((k) => k.toLowerCase() === normalized.toLowerCase())
  if (exact) return exact

  const base = normalized.split('-')[0].toLowerCase()
  return keys.find((k) => k.toLowerCase().startsWith(base))
}

function getCookieLang() {
  const match = document.cookie.match(/(?:^|;\s*)CockpitLang=([^;]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

function detectLocale() {
  // Priority: CockpitLang cookie > cockpit.language > navigator.language
  const lang =
    getCookieLang() ||
    (typeof cockpit !== 'undefined' && cockpit.language) ||
    navigator.language ||
    'en'
  const match = findLocale(lang)
  if (match) state.locale = match
}

export function initLocale() {
  detectLocale()
  try {
    cockpit.transport.wait(() => detectLocale())
    cockpit.addEventListener('languagechange', detectLocale)
  } catch {
    // cockpit not available
  }
}

export function t(key, params) {
  const msg = messages[state.locale]?.[key] || messages.en[key] || key
  if (!params) return msg
  return msg.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? _)
}
