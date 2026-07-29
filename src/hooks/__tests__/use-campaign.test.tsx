import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useCampaign } from '../use-campaign'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

describe('useCampaign', () => {
  beforeEach(() => {
    global.fetch = jest.fn((url: string) => {
      const id = url.split('/').pop()

      const campaigns: Record<string, unknown> = {
        '2': {
          id: '2',
          title: 'Medical Supplies for Children',
          description:
            'Supplying essential medical equipment and medicines to children in need across multiple healthcare facilities.',
          targetAmount: 25000,
          raisedAmount: 22000,
          status: 'active',
          category: 'healthcare',
          ngoName: 'Doctors Without Borders',
          endDate: '2026-07-15',
          imageUrl: '/api/placeholder/400/200',
          ngoId: 'ngo-2',
          createdAt: '2026-04-10',
          location: { country: 'Kenya', region: 'Nairobi County', city: 'Nairobi' },
          beneficiaries: [
            { id: '1', name: 'Clinic A', status: 'verified', allocatedAmount: 4000 },
            { id: '2', name: 'Clinic B', status: 'pending', allocatedAmount: 3000 },
          ],
        },
      }

      return Promise.resolve({
        ok: true,
        json: async () => ({ campaign: campaigns[id as string] ?? null }),
      }) as unknown as Promise<Response>
    }) as jest.Mock
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  it("returns the 'Medical Supplies for Children' campaign for id '2'", async () => {
    const { result } = renderHook(() => useCampaign('2'), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data?.title).toBe('Medical Supplies for Children')
  })

  it("returns null for an id that doesn't match any campaign", async () => {
    const { result } = renderHook(() => useCampaign('999'), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(result.current.data).toBeNull()
  })
})
