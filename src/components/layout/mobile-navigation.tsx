'use client'

import { usePathname } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useWalletStore } from '@/store/wallet-store'
import { Home, Compass, BarChart3, User } from 'lucide-react'
import { cn } from '@/lib/utils'
import { NotificationCenter } from '@/components/features/notification-center'

export function MobileNavigation() {
  const pathname = usePathname()
  const { isConnected } = useWalletStore()

  const navItems = [
    {
      href: '/',
      icon: Home,
      label: 'Home',
      show: true,
    },
    {
      href: '/campaigns',
      icon: Compass,
      label: 'Campaigns',
      show: true,
    },
    {
      href: '/dashboard',
      icon: BarChart3,
      label: 'Dashboard',
      show: isConnected,
    },
    {
      href: '/profile',
      icon: User,
      label: 'Profile',
      show: isConnected,
    },
  ]

  return (
    <div className="fixed bottom-0 left-0 right-0 z-50 md:hidden bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60 border-t">
      <div className="flex items-center justify-around h-16 px-4">
        {navItems
          .filter((item) => item.show)
          .map((item) => {
            const isActive = item.href === '/'
              ? pathname === item.href
              : pathname === item.href || pathname.startsWith(item.href + '/')
            return (
              <Button
                key={item.href}
                variant="ghost"
                size="sm"
                className={cn(
                  'flex flex-col items-center gap-1 h-full py-2 px-3 rounded-lg',
                  isActive && 'bg-primary/10 text-primary'
                )}
                asChild
              >
                <a href={item.href} aria-current={isActive ? 'page' : undefined}>
                  <item.icon className="h-5 w-5" />
                  <span className="text-xs">{item.label}</span>
                </a>
              </Button>
            )
          })}
        
        <div className="flex flex-col items-center gap-1 h-full py-2 px-3">
          <NotificationCenter />
        </div>
      </div>
    </div>
  )
}
