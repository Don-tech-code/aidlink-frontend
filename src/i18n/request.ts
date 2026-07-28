import { getRequestConfig } from 'next-intl/server'
import { routing, type Locale } from './routing'

/**
 * Per-request next-intl configuration.
 *
 * Messages are loaded with a dynamic import keyed by the active locale, so a
 * request only ever bundles/serves the messages for that single locale
 * (lazy-loading — the other locales are never sent to the client).
 */
export default getRequestConfig(async ({ requestLocale }) => {
  // `requestLocale` is derived from the `[locale]` segment once localized
  // routing is in place; until then it safely falls back to the default.
  const requested = await requestLocale
  const locale: Locale = routing.locales.includes(requested as Locale)
    ? (requested as Locale)
    : routing.defaultLocale

  return {
    locale,
    messages: (await import(`../../messages/${locale}.json`)).default,
  }
})
