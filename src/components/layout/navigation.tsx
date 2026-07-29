'use client'

import { Button } from '@/components/ui/button'
import { useWalletStore } from '@/store/wallet-store'
import { NotificationCenter } from '@/components/features/notification-center'
import { ThemeToggle } from '@/components/features/theme/theme-toggle'
import { Wallet, LogOut, Menu, X } from 'lucide-react'
import { useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { formatAddress } from '@/lib/utils'

export function Navigation() {
  const { isConnected, address, disconnect } = useWalletStore()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)
  const t = useTranslations('Nav')

  return (
    <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center space-x-2">
          <Wallet className="h-6 w-6 text-primary" />
          <span className="text-xl font-bold">AidLink</span>
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden items-center space-x-6 md:flex">
          <Link href="/campaigns" className="text-sm font-medium hover:text-primary">
            Campaigns
          </Link>
          <Link href="/about" className="text-sm font-medium hover:text-primary">
            About
          </Link>
          <ThemeToggle />
          {isConnected ? (
            <>
              <Link href="/dashboard" className="text-sm font-medium hover:text-primary">
                Dashboard
              </Link>
              <div className="flex items-center space-x-2">
                <NotificationCenter />
                <span className="text-sm text-muted-foreground">{formatAddress(address || '')}</span>
                <Button variant="ghost" size="icon" onClick={disconnect}>
                  <LogOut className="h-4 w-4" />
                </Button>
              </div>
            </>
          ) : (
            <Link href="/auth">
              <Button>Connect Wallet</Button>
            </Link>
          )}
        </div>

        {/* Mobile Menu Button */}
        <button
          className="md:hidden"
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          aria-label="Toggle menu"
        >
          {mobileMenuOpen ? <X className="h-6 w-6" /> : <Menu className="h-6 w-6" />}
        </button>
      </div>

      {/* Mobile Navigation */}
      {mobileMenuOpen && (
        <div className="border-t md:hidden">
          <div className="container space-y-4 py-4">
            <Link href="/campaigns" className="block text-sm font-medium">
              Campaigns
            </Link>
            <Link href="/about" className="block text-sm font-medium">
              About
            </Link>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Theme</span>
              <ThemeToggle />
            </div>
            {isConnected ? (
              <>
                <Link href="/dashboard" className="block text-sm font-medium">
                  Dashboard
                </Link>
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">{formatAddress(address || '')}</span>
                  <Button variant="ghost" size="icon" onClick={disconnect}>
                    <LogOut className="h-4 w-4" />
                  </Button>
                </div>
              </>
            ) : (
              <Link href="/auth">
                <Button className="w-full">Connect Wallet</Button>
              </Link>
            )}
          </div>
        </div>
      )}
    </nav>
  )
}
