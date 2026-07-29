/**
 * Unit tests for TransactionExporter
 * Covers all acceptance criteria from issue #92.
 */

import {
  TransactionExporter,
  computeHmac,
  toCsvRow,
  CSV_HEADERS,
  type ExportedTransaction,
} from '../transaction-exporter'

// ---------------------------------------------------------------------------
// Helpers to build fake Horizon records
// ---------------------------------------------------------------------------

function makePaymentRecord(overrides: Record<string, unknown> = {}) {
  return {
    type: 'payment',
    paging_token: 'a'.repeat(64),
    transaction_hash: 'b'.repeat(64),
    created_at: '2026-07-21T06:33:29Z',
    from: 'GABC1234',
    to: 'GXYZ5678',
    amount: '50.0000000',
    asset_type: 'native',
    transaction_successful: true,
    _links: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Mock @stellar/stellar-sdk Horizon.Server
// ---------------------------------------------------------------------------

jest.mock('@stellar/stellar-sdk', () => {
  const mockCall = jest.fn()
  const mockCursor = jest.fn().mockReturnThis()
  const mockOrder = jest.fn().mockReturnThis()
  const mockLimit = jest.fn().mockReturnThis()
  const mockForAccount = jest.fn().mockReturnThis()
  const mockPayments = jest.fn().mockReturnValue({
    forAccount: mockForAccount,
    limit: mockLimit,
    order: mockOrder,
    cursor: mockCursor,
    call: mockCall,
  })

  return {
    Horizon: {
      Server: jest.fn().mockImplementation(() => ({
        payments: mockPayments,
      })),
    },
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TransactionExporter.export', () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it('returns 3 transactions when mock returns 3 payment records', async () => {
    const records = [
      makePaymentRecord({ paging_token: 'c'.repeat(64), transaction_hash: 'c'.repeat(64) }),
      makePaymentRecord({ paging_token: 'd'.repeat(64), transaction_hash: 'd'.repeat(64) }),
      makePaymentRecord({ paging_token: 'e'.repeat(64), transaction_hash: 'e'.repeat(64) }),
    ]

    const pageResponse = {
      records,
      next: jest.fn().mockResolvedValue({ records: [], next: jest.fn() }),
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Horizon } = require('@stellar/stellar-sdk')
    const serverInstance = new Horizon.Server('')
    serverInstance.payments().forAccount('').limit(200).order('desc').cursor('').call = jest
      .fn()
      .mockResolvedValue(pageResponse)
    ;(Horizon.Server as jest.Mock).mockImplementationOnce(() => serverInstance)

    const exporter = new TransactionExporter()
    const result = await exporter.export('GPUBKEY', 'testnet', { maxTransactions: 3 })

    expect(result.transactions).toHaveLength(3)
    expect(result.totalFetched).toBe(3)
    // Each txHash should be a 64-char hex string
    for (const tx of result.transactions) {
      expect(tx.txHash).toMatch(/^[0-9a-f]{64}$/i)
    }
  })

  it('calls onProgress at least twice when mock returns 2 pages of 200 records each', async () => {
    const makeRecords = (prefix: string) =>
      Array.from({ length: 200 }, (_, i) =>
        makePaymentRecord({
          paging_token: prefix.repeat(1) + i.toString().padStart(63, '0'),
          transaction_hash: prefix.repeat(1) + i.toString().padStart(63, '0'),
        })
      )

    const page2 = {
      records: makeRecords('b'),
      next: jest.fn().mockResolvedValue({ records: [], next: jest.fn() }),
    }
    const page1 = {
      records: makeRecords('a'),
      next: jest.fn().mockResolvedValue(page2),
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Horizon } = require('@stellar/stellar-sdk')
    const serverInstance = new Horizon.Server('')
    serverInstance.payments().forAccount('').limit(200).order('desc').cursor('').call = jest
      .fn()
      .mockResolvedValue(page1)
    ;(Horizon.Server as jest.Mock).mockImplementationOnce(() => serverInstance)

    const progressCalls: number[] = []
    const exporter = new TransactionExporter()
    await exporter.export('GPUBKEY', 'testnet', {
      maxTransactions: 400,
      onProgress: (n) => progressCalls.push(n),
    })

    expect(progressCalls.length).toBeGreaterThanOrEqual(2)
    // Counts should be increasing
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i]).toBeGreaterThan(progressCalls[i - 1])
    }
  })
})

// ---------------------------------------------------------------------------
// CSV generation tests
// ---------------------------------------------------------------------------

describe('TransactionExporter.generateCsv', () => {
  const singleTx: ExportedTransaction = {
    txHash: 'f'.repeat(64),
    timestamp: '2026-07-21T06:33:29Z',
    operationType: 'payment',
    from: 'GABC',
    to: 'GXYZ',
    amount: '50.0000000',
    currency: 'XLM',
    campaignId: null,
    status: 'success',
  }

  it('first non-comment line is the header row', async () => {
    const exporter = new TransactionExporter()
    const result = {
      transactions: [singleTx],
      cursor: singleTx.txHash,
      totalFetched: 1,
    }
    const blob = await exporter.generateCsv(result, 'GWALLET', 'testnet', '2026-07-21T06:33:29Z')
    const text = await blob.text()
    const lines = text.split('\n')
    const firstNonComment = lines.find((l) => l.trim() !== '' && !l.startsWith('#'))
    expect(firstNonComment).toBe(CSV_HEADERS.join(','))
  })

  it('second data line contains transaction data', async () => {
    const exporter = new TransactionExporter()
    const result = { transactions: [singleTx], cursor: singleTx.txHash, totalFetched: 1 }
    const blob = await exporter.generateCsv(result, 'GWALLET', 'testnet', '2026-07-21T06:33:29Z')
    const text = await blob.text()
    const nonComment = text.split('\n').filter((l) => l.trim() !== '' && !l.startsWith('#'))
    // nonComment[0] = header, nonComment[1] = data row
    expect(nonComment[1]).toContain(singleTx.txHash)
    expect(nonComment[1]).toContain('payment')
  })

  it('comment block contains Provenance: HMAC-SHA256/...', async () => {
    const exporter = new TransactionExporter()
    const result = { transactions: [singleTx], cursor: singleTx.txHash, totalFetched: 1 }
    const blob = await exporter.generateCsv(result, 'GWALLET', 'testnet', '2026-07-21T06:33:29Z')
    const text = await blob.text()
    expect(text).toMatch(/^# Provenance: HMAC-SHA256\/.+/m)
  })
})

// ---------------------------------------------------------------------------
// Provenance HMAC determinism
// ---------------------------------------------------------------------------

describe('computeHmac', () => {
  it('is deterministic — same inputs produce the same HMAC on two independent calls', async () => {
    const wallet = 'GB5XWAMU7KZQNPZXE2YBXEPQFB2YGQSJMK4X7A'
    const ts = '2026-07-21T06:33:29Z'
    const body = 'some,csv,body\n"row","data"\n'

    const [hmac1, hmac2] = await Promise.all([
      computeHmac(wallet, ts, body),
      computeHmac(wallet, ts, body),
    ])

    expect(hmac1).toBe(hmac2)
    expect(hmac1.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// JSON provenance tests
// ---------------------------------------------------------------------------

describe('TransactionExporter.generateJson', () => {
  const singleTx: ExportedTransaction = {
    txHash: 'a'.repeat(64),
    timestamp: '2026-07-21T06:33:29Z',
    operationType: 'payment',
    from: 'GABC',
    to: 'GXYZ',
    amount: '10.0000000',
    currency: 'XLM',
    campaignId: null,
    status: 'success',
  }

  it('includes _provenance.contentHmac field', async () => {
    const exporter = new TransactionExporter()
    const result = { transactions: [singleTx], cursor: singleTx.txHash, totalFetched: 1 }
    const blob = await exporter.generateJson(result, 'GWALLET', 'testnet', '2026-07-21T06:33:29Z')
    const parsed = JSON.parse(await blob.text())
    expect(parsed._provenance).toBeDefined()
    expect(typeof parsed._provenance.contentHmac).toBe('string')
    expect(parsed._provenance.contentHmac.length).toBeGreaterThan(0)
  })

  it('mutating the exported JSON body causes the HMAC to no longer match', async () => {
    const wallet = 'GWALLET'
    const ts = '2026-07-21T06:33:29Z'
    const exporter = new TransactionExporter()
    const result = { transactions: [singleTx], cursor: singleTx.txHash, totalFetched: 1 }
    const blob = await exporter.generateJson(result, wallet, 'testnet', ts)
    const parsed = JSON.parse(await blob.text())

    const originalHmac = parsed._provenance.contentHmac

    // Tamper: change amount on the transaction
    const tamperedTransactions = parsed.transactions.map((tx: ExportedTransaction) => ({
      ...tx,
      amount: '999.0',
    }))
    const tamperedBody = JSON.stringify(tamperedTransactions)

    const recomputedHmac = await computeHmac(wallet, ts, tamperedBody)
    expect(recomputedHmac).not.toBe(originalHmac)
  })
})

// ---------------------------------------------------------------------------
// Streaming memory-bounded CSV test
// ---------------------------------------------------------------------------

describe('Streaming CSV memory bound', () => {
  it('never holds more than 200 transactions in memory at one time during generation', async () => {
    const transactions: ExportedTransaction[] = Array.from({ length: 500 }, (_, i) => ({
      txHash: i.toString(16).padStart(64, '0'),
      timestamp: '2026-07-21T06:33:29Z',
      operationType: 'payment',
      from: 'GABC',
      to: 'GXYZ',
      amount: '1.0000000',
      currency: 'XLM',
      campaignId: null,
      status: 'success' as const,
    }))

    // Track peak chunk size written at a time by spying on Array.slice
    let peakChunkSize = 0
    const originalSlice = Array.prototype.slice

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sliceSpy = jest.spyOn(transactions as any, 'slice').mockImplementation(function (...args: unknown[]) {
      const chunk = originalSlice.apply(transactions, args as [number?, number?]) as ExportedTransaction[]
      if (chunk.length > peakChunkSize) peakChunkSize = chunk.length
      return chunk
    })

    const exporter = new TransactionExporter()
    const result = { transactions, cursor: '', totalFetched: 500 }
    await exporter.generateCsv(result, 'GWALLET', 'testnet', '2026-07-21T06:33:29Z')

    sliceSpy.mockRestore()

    expect(peakChunkSize).toBeLessThanOrEqual(200)
  })
})

// ---------------------------------------------------------------------------
// toCsvRow escaping
// ---------------------------------------------------------------------------

describe('toCsvRow', () => {
  it('escapes double-quotes in field values', () => {
    const tx: ExportedTransaction = {
      txHash: 'a'.repeat(64),
      timestamp: '2026-07-21T06:33:29Z',
      operationType: 'payment',
      from: 'G"MALICIOUS',
      to: 'GXYZ',
      amount: '1.0',
      currency: 'XLM',
      campaignId: null,
      status: 'success',
    }
    const row = toCsvRow(tx)
    expect(row).toContain('"G""MALICIOUS"')
  })
})
