import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { NextIntlClientProvider } from 'next-intl'
import { getLocale, getMessages, getTranslations } from 'next-intl/server'
import { getLangDir } from '@/i18n/routing'
import { ThemeProvider } from '@/components/providers/theme-provider'
import { QueryProvider } from '@/components/providers/query-provider'
import { Toaster } from '@/components/ui/toaster'
import { MobileNavigation } from '@/components/layout/mobile-navigation'

const inter = Inter({ subsets: ['latin'] })

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('Metadata')
  return {
    title: t('title'),
    description: t('description'),
    keywords: ['humanitarian aid', 'blockchain', 'Stellar', 'Soroban', 'charity', 'donations'],
  }
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Resolved by next-intl from the request (URL prefix → cookie → Accept-Language).
  const locale = await getLocale()
  const messages = await getMessages()
  const dir = getLangDir(locale)

  return (
    <html lang={locale} dir={dir} suppressHydrationWarning>
      <body className={inter.className}>
        <NextIntlClientProvider locale={locale} messages={messages}>
          <ThemeProvider>
            <QueryProvider>
              {children}
              <MobileNavigation />
              <Toaster />
            </QueryProvider>
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
