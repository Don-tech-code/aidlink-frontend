import { defineRouting } from 'next-intl/routing'

/**
 * The list of locales supported by the application.
 * `en` is the default and is served without a URL prefix (localePrefix: 'as-needed').
 */
export const locales = ['en', 'ar', 'fr'] as const

export type Locale = (typeof locales)[number]

export const defaultLocale: Locale = 'en'

/**
 * Locales that are rendered right-to-left. Used to set the `dir` attribute
 * on the <html> element and to mirror direction-sensitive UI.
 */
export const rtlLocales: readonly Locale[] = ['ar'] as const

/**
 * Human-readable names for each locale, shown in the language switcher.
 * The value is intentionally the *endonym* (name in its own language).
 */
export const localeNames: Record<Locale, string> = {
  en: 'English',
  ar: 'العربية',
  fr: 'Français',
}

export const routing = defineRouting({
  locales,
  defaultLocale,
  // Only prefix non-default locales (e.g. `/ar`, `/fr`); English stays at `/`.
  localePrefix: 'as-needed',
  // Enable automatic detection via the NEXT_LOCALE cookie and the
  // Accept-Language header (in that order of precedence).
  localeDetection: true,
})

/** Type guard that narrows an arbitrary string to a supported Locale. */
export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (locales as readonly string[]).includes(value)
}

/** Whether the given locale should be rendered right-to-left. */
export function isRtlLocale(locale: string): boolean {
  return (rtlLocales as readonly string[]).includes(locale)
}

/** Returns the text direction for a given locale. */
export function getLangDir(locale: string): 'rtl' | 'ltr' {
  return isRtlLocale(locale) ? 'rtl' : 'ltr'
}
