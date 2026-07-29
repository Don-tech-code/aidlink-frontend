'use client'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Download, FileSpreadsheet, FileText } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from 'next-intl'
import { formatDate } from '@/lib/utils'

export interface Transaction {
  id: string
  type: string
  to: string
  amount: number
  status: string
  timestamp: Date
}

interface ExportButtonProps {
  transactions: Transaction[]
  filename?: string
}

export function ExportButton({ transactions, filename = 'donation-history' }: ExportButtonProps) {
  const locale = useLocale()

  const exportToCSV = () => {
    if (transactions.length === 0) {
      toast.error('No transactions to export')
      return
    }

    const headers = ['ID', 'Type', 'To', 'Amount (XLM)', 'Status', 'Date']
    const rows = transactions.map((tx) => [
      tx.id,
      tx.type,
      tx.to,
      tx.amount.toString(),
      tx.status,
      formatDate(tx.timestamp, locale),
    ])

    const csvContent = [
      headers.join(','),
      ...rows.map((row) => row.map((cell) => `"${cell}"`).join(',')),
    ].join('\n')

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${filename}.csv`
    link.click()
    URL.revokeObjectURL(link.href)

    toast.success('Exported to CSV successfully')
  }

  const exportToJSON = () => {
    if (transactions.length === 0) {
      toast.error('No transactions to export')
      return
    }

    const jsonContent = JSON.stringify(transactions, null, 2)
    const blob = new Blob([jsonContent], { type: 'application/json;charset=utf-8;' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = `${filename}.json`
    link.click()
    URL.revokeObjectURL(link.href)

    toast.success('Exported to JSON successfully')
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm">
          <Download className="mr-2 h-4 w-4" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={exportToCSV}>
          <FileSpreadsheet className="mr-2 h-4 w-4" />
          Export as CSV
        </DropdownMenuItem>
        <DropdownMenuItem onClick={exportToJSON}>
          <FileText className="mr-2 h-4 w-4" />
          Export as JSON
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
