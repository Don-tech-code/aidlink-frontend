import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sorobanSDK, type InvokeContractParams, type InvokeContractResult } from '@/lib/soroban/sdk'
import { toast } from 'sonner'

export function useBalance(accountId: string | null) {
  return useQuery({
    queryKey: ['balance', accountId],
    queryFn: () => sorobanSDK.getBalance(accountId || ''),
    enabled: !!accountId,
    staleTime: 30000,
  })
}

/**
 * Runs the full Soroban write-transaction lifecycle (issue #85):
 * prepare → simulate → (restore footprint if needed) → sign → submit →
 * poll until finality. The mutation only resolves once the transaction is
 * confirmed SUCCESS on-chain — it does not resolve early on a "submitted"
 * or PENDING response the way the previous fire-and-forget implementation
 * did.
 */
export function useContractInvoke() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (params: InvokeContractParams): Promise<InvokeContractResult> => {
      return await sorobanSDK.invokeContract(params)
    },
    onSuccess: () => {
      toast.success('Contract invocation confirmed on-chain')
      queryClient.invalidateQueries({ queryKey: ['contract'] })
    },
    onError: (error) => {
      toast.error('Contract invocation failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    },
  })
}

/**
 * Thin alias over useContractInvoke (issue #85). Previously this wrapped a
 * separate fire-and-forget submitTransaction() that returned as soon as
 * sendTransaction responded, without waiting for the transaction to
 * actually finalize. invokeContract() now owns the entire submit→poll
 * loop, so there is nothing left for this hook to do differently — it's
 * kept as a named alias for call sites that talk about "submitting a
 * transaction" rather than "invoking a contract".
 */
export function useTransactionSubmit() {
  return useContractInvoke()
}

export function useTransactionStatus(txHash: string | null) {
  return useQuery({
    queryKey: ['transaction-status', txHash],
    queryFn: () => sorobanSDK.getTransactionStatus(txHash || ''),
    enabled: !!txHash,
    refetchInterval: (query) => {
      // Refetch every 2 seconds until transaction is successful
      return query.state.data?.status === 'SUCCESS' ? false : 2000
    },
  })
}
