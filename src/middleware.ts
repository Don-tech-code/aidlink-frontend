import createMiddleware from 'next-intl/middleware'
import { routing } from '@/i18n/routing'

/**
 * next-intl middleware.
 *
 * Handles locale detection and routing:
 *  1. An explicit locale in the URL (e.g. `/ar/...`) always wins.
 *  2. Otherwise the `NEXT_LOCALE` cookie is used, if present.
 *  3. Otherwise the `Accept-Language` request header is negotiated against
 *     the supported locales.
 *  4. Falling back to the default locale (`en`).
 *
 * With `localePrefix: 'as-needed'`, the default locale is served without a
 * prefix while non-default locales are prefixed. The middleware also persists
 * the resolved locale in the `NEXT_LOCALE` cookie.
 */
export default createMiddleware(routing)

export const config = {
  // Match all pathnames except for:
  //  - API routes (`/api`, `/trpc`)
  //  - Next.js internals (`/_next`, `/_vercel`)
  //  - the health check route
  //  - any path that contains a dot (static files such as `favicon.ico`)
  matcher: ['/((?!api|_next|_vercel|health|.*\\..*).*)'],
}
