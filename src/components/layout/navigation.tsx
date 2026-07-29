'use client'

import { Button } from '@/components/ui/button'
import { useWalletStore } from '@/store/wallet-store'
import { NotificationCenter } from '@/components/features/notification-center'
import { ThemeToggle } from '@/components/features/theme/theme-toggle'
import { Wallet, LogOut, Menu, X } from 'lucide-react'
import { useState } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { formatAddress, cn } from '@/lib/utils'

export function Navigation() {
  const { isConnected, address, disconnect } = useWalletStore()
  const pathname = usePathname()
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false)

  function isActive(href: string) {
    if (href === '/') return pathname === '/'
    return pathname === href || pathname.startsWith(href + '/')
  }

  function navLinkClass(href: string) {
    return cn(
      'text-sm font-medium hover:text-primary',
      isActive(href) && 'text-primary font-semibold'
    )
  }

  return (
    <nav className="border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="container flex h-16 items-center justify-between">
        <Link href="/" className="flex items-center space-x-2">
          <Wallet className="h-6 w-6 text-primary" />
          <span className="text-xl font-bold">AidLink</span>
        </Link>

        {/* Desktop Navigation */}
        <div className="hidden items-center space-x-6 md:flex">
          <Link href="/campaigns" className={navLinkClass('/campaigns')} aria-current={isActive('/campaigns') ? 'page' : undefined}>
            Campaigns
          </Link>
          <Link href="/about" className={navLinkClass('/about')} aria-current={isActive('/about') ? 'page' : undefined}>
            About
          </Link>
          <ThemeToggle />
          {isConnected ? (
            <>
              <Link href="/dashboard" className={navLinkClass('/dashboard')} aria-current={isActive('/dashboard') ? 'page' : undefined}>
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
            <Link href="/campaigns" className={cn('block text-sm font-medium', isActive('/campaigns') && 'text-primary font-semibold')} aria-current={isActive('/campaigns') ? 'page' : undefined}>
              Campaigns
            </Link>
            <Link href="/about" className={cn('block text-sm font-medium', isActive('/about') && 'text-primary font-semibold')} aria-current={isActive('/about') ? 'page' : undefined}>
              About
            </Link>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Theme</span>
              <ThemeToggle />
            </div>
            {isConnected ? (
              <>
                <Link href="/dashboard" className={cn('block text-sm font-medium', isActive('/dashboard') && 'text-primary font-semibold')} aria-current={isActive('/dashboard') ? 'page' : undefined}>
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
