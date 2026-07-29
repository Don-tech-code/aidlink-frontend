jest.mock('@/components/layout/navigation', () => ({
  Navigation: () => null,
}))

jest.mock('next/navigation', () => {
  let currentId = '1'
  return {
    useRouter: () => ({ push: jest.fn() }),
    useParams: () => ({ id: currentId }),
    __setParamId: (id: string) => {
      currentId = id
    },
  }
})

// Mock the wallet store so the page can render without a real wallet
jest.mock('@/store/wallet-store', () => ({
  useWalletStore: () => ({
    isConnected: false,
    address: null,
    publicKey: null,
    network: 'testnet',
    balance: '0',
  }),
}))

// Mock useDonation so the page renders without a Stellar RPC
jest.mock('@/hooks/use-donation', () => ({
  useDonation: () => ({
    state: {
      status: 'idle',
      estimatedFee: null,
      txHash: null,
      error: null,
      isDuplicate: false,
    },
    donate: jest.fn(),
    reset: jest.fn(),
    feeConfirmed: jest.fn(),
    feeDismissed: jest.fn(),
  }),
  WalletNotConnectedError: class WalletNotConnectedError extends Error {
    constructor() {
      super('Wallet is not connected')
    }
  },
}))

import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import CampaignDetailPage from './page'
import { fetchCampaignById } from '@/lib/campaigns/data'

// The page fetches via `fetch('/api/campaigns/:id')`, which has no real
// server to hit under jest. Mock it against the same fetchCampaignById
// the real API route uses, so this stays a true integration test of the
// page + useCampaign hook without needing a running server.
global.fetch = jest.fn(async (url: string) => {
  const id = url.toString().split('/').pop() as string
  const campaign = await fetchCampaignById(id)
  return {
    ok: true,
    json: async () => ({ campaign }),
  } as Response
}) as jest.Mock

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
}

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = createTestQueryClient()
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
  )
}

describe('CampaignDetailPage', () => {
  beforeEach(() => {
    jest.requireMock('next/navigation').__setParamId('1')
  })

  it('shows loading placeholders and then the campaign matching the URL id', async () => {
    const { container } = renderWithProviders(<CampaignDetailPage />)

    expect(container.querySelector('.animate-pulse')).toBeTruthy()
    expect(screen.queryByText('Emergency Relief for Flood Victims')).toBeNull()

    await waitFor(() =>
      expect(screen.queryByText('Emergency Relief for Flood Victims')).not.toBeNull(),
    )
    expect(container.querySelector('.animate-pulse')).toBeNull()
  })

  it('shows a different campaign for a different id (issue #98)', async () => {
    jest.requireMock('next/navigation').__setParamId('3')

    renderWithProviders(<CampaignDetailPage />)

    await waitFor(() =>
      expect(screen.queryByText('Education Initiative in Rural Areas')).not.toBeNull(),
    )
    expect(screen.queryByText('Emergency Relief for Flood Victims')).toBeNull()
  })

  it('shows a not-found state for an id with no matching campaign', async () => {
    jest.requireMock('next/navigation').__setParamId('999')

    renderWithProviders(<CampaignDetailPage />)

    await waitFor(() => expect(screen.queryByText('Campaign not found')).not.toBeNull())
  })
})
