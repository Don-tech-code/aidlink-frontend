import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { defaultLocale } from '@/i18n/routing'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatAddress(address: string, chars = 4): string {
  return `${address.substring(0, chars + 2)}...${address.substring(address.length - chars)}`
}

export function formatAmount(
  amount: number | string,
  decimals = 2,
  locale: string = defaultLocale
): string {
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  return new Intl.NumberFormat(locale, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(num)
}

export function formatDate(
  date: Date | string,
  locale: string = defaultLocale
): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return new Intl.DateTimeFormat(locale, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(d)
}

export function formatTime(
  date: Date | string,
  locale: string = defaultLocale
): string {
  const d = typeof date === 'string' ? new Date(date) : date
  return new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(d)
}

export function formatDateTime(
  date: Date | string,
  locale: string = defaultLocale
): string {
  return `${formatDate(date, locale)} at ${formatTime(date, locale)}`
}

export function truncate(str: string, length: number): string {
  if (str.length <= length) return str
  return str.substring(0, length) + '...'
}

export function calculateCampaignProgress(
  raisedAmount: number,
  targetAmount: number
): number {
  const raised = Math.max(0, Number(raisedAmount) || 0)
  const target = Math.max(0, Number(targetAmount) || 0)

  if (target === 0) {
    return raised > 0 ? 100 : 0
  }

  return Math.min(100, Math.max(0, (raised / target) * 100))
}

export function getCampaignFundingStatus(
  raisedAmount: number,
  targetAmount: number
): { label: string; description: string } {
  const raised = Math.max(0, Number(raisedAmount) || 0)
  const target = Math.max(0, Number(targetAmount) || 0)

  if (raised <= 0) {
    return { label: '0% funded', description: 'No contributions yet' }
  }

  if (target <= 0) {
    return { label: '100% funded', description: 'Campaign fully funded' }
  }

  if (raised >= target) {
    return { label: '100% funded', description: 'Campaign fully funded' }
  }

  const progress = (raised / target) * 100
  const remaining = target - raised

  return {
    label: `${progress.toFixed(0)}% funded`,
    description: `${formatAmount(remaining)} XLM remaining`,
  }
}
