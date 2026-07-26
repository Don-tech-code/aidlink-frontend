import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import { ThemeToggle } from './theme-toggle'
import { useUIStore } from '@/store/ui-store'

let mockTheme = 'light'
const mockSetTheme = jest.fn()

jest.mock('next-themes', () => {
  const { useState } = require('react')
  return {
    useTheme: () => {
      const [theme, setThemeState] = useState(() => mockTheme)
      return {
        theme,
        setTheme: (next: string) => {
          mockTheme = next
          mockSetTheme(next)
          setThemeState(next)
        },
      }
    },
  }
})

describe('ThemeToggle (issue #99)', () => {
  beforeEach(() => {
    mockTheme = 'light'
    mockSetTheme.mockClear()
    useUIStore.setState({ theme: 'system' })
  })

  it('cycles light -> dark -> system -> light across three clicks', () => {
    render(<ThemeToggle />)
    const button = screen.getByRole('button')

    fireEvent.click(button)
    expect(mockSetTheme).toHaveBeenLastCalledWith('dark')

    fireEvent.click(button)
    expect(mockSetTheme).toHaveBeenLastCalledWith('system')

    fireEvent.click(button)
    expect(mockSetTheme).toHaveBeenLastCalledWith('light')
  })

  it('uses "Switch to dark mode" as the aria-label in light mode', () => {
    mockTheme = 'light'
    render(<ThemeToggle />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to dark mode')
  })

  it('uses "Switch to system theme" as the aria-label in dark mode', () => {
    mockTheme = 'dark'
    render(<ThemeToggle />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to system theme')
  })

  it('uses "Switch to light mode" as the aria-label in system mode', () => {
    mockTheme = 'system'
    render(<ThemeToggle />)
    expect(screen.getByRole('button')).toHaveAttribute('aria-label', 'Switch to light mode')
  })

  it('updates UIStore.theme to match each cycle step', () => {
    mockTheme = 'light'
    render(<ThemeToggle />)
    const button = screen.getByRole('button')

    fireEvent.click(button)
    expect(useUIStore.getState().theme).toBe('dark')

    fireEvent.click(button)
    expect(useUIStore.getState().theme).toBe('system')

    fireEvent.click(button)
    expect(useUIStore.getState().theme).toBe('light')
  })

  it('renders the Monitor icon when theme is "system"', () => {
    mockTheme = 'system'
    const { container } = render(<ThemeToggle />)
    expect(container.querySelector('.lucide-monitor')).toBeInTheDocument()
  })
})
