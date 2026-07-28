import type en from './messages/en.json'

/**
 * Type-safe next-intl integration.
 *
 * By declaring the shape of our messages here, `useTranslations`,
 * `getTranslations` and related APIs validate namespace/key names against
 * `messages/en.json` at compile time. `en.json` is treated as the source of
 * truth for available keys.
 */
declare module 'next-intl' {
  interface AppConfig {
    Messages: typeof en
  }
}
