'use client'

import { Monitor, Moon, Sun } from 'lucide-react'
import { useTheme } from 'next-themes'
import { Button } from '@/components/ui/button'
import { useEffect, useState } from 'react'
import { useUIStore } from '@/store/ui-store'

type Theme = 'light' | 'dark' | 'system'

const NEXT_THEME: Record<Theme, Theme> = {
  light: 'dark',
  dark: 'system',
  system: 'light',
}

const NEXT_THEME_LABEL: Record<Theme, string> = {
  light: 'Switch to dark mode',
  dark: 'Switch to system theme',
  system: 'Switch to light mode',
}

export function ThemeToggle() {
  const { theme, setTheme } = useTheme()
  const [mounted, setMounted] = useState(false)

  useEffect(() => {
    setMounted(true)

    const storedTheme = useUIStore.getState().theme
    if (storedTheme !== 'system') {
      setTheme(storedTheme)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  if (!mounted) {
    return (
      <Button variant="ghost" size="icon" disabled>
        <Sun className="h-5 w-5" />
      </Button>
    )
  }

  const currentTheme = (theme as Theme) ?? 'system'
  const nextTheme = NEXT_THEME[currentTheme]

  const handleClick = () => {
    setTheme(nextTheme)
    useUIStore.getState().setTheme(nextTheme)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={handleClick}
      aria-label={NEXT_THEME_LABEL[currentTheme]}
    >
      {currentTheme === 'dark' ? (
        <Sun className="h-5 w-5" />
      ) : currentTheme === 'system' ? (
        <Monitor className="h-5 w-5" />
      ) : (
        <Moon className="h-5 w-5" />
      )}
    </Button>
  )
}
