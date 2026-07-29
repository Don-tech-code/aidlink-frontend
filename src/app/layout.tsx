import type { Metadata } from 'next'
import { Inter } from 'next/font/google'
import './globals.css'
import { ThemeProvider } from '@/components/providers/theme-provider'
import { QueryProvider } from '@/components/providers/query-provider'
import { Toaster } from '@/components/ui/toaster'
import { MobileNavigation } from '@/components/layout/mobile-navigation'
import { NetworkGuard } from '@/components/features/wallet/network-guard'

const inter = Inter({ subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'AidLink - Decentralized Humanitarian Aid Platform',
  description: 'Transparent, efficient, and secure humanitarian aid distribution powered by Stellar blockchain',
  keywords: ['humanitarian aid', 'blockchain', 'Stellar', 'Soroban', 'charity', 'donations'],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={inter.className}>
        <ThemeProvider>
          <QueryProvider>
            <NetworkGuard>
              {children}
              <MobileNavigation />
            </NetworkGuard>
            <Toaster />
          </QueryProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
