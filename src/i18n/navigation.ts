import { createNavigation } from 'next-intl/navigation'
import { routing } from './routing'

/**
 * Locale-aware navigation APIs. Prefer these over the equivalents from
 * `next/navigation` and `next/link` so that the active locale prefix is
 * handled automatically (respecting `localePrefix: 'as-needed'`).
 */
export const { Link, redirect, usePathname, useRouter, getPathname } =
  createNavigation(routing)
