import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { sorobanSDK } from '@/lib/soroban/sdk'
import { toast } from 'sonner'

export function useBalance(accountId: string | null) {
  return useQuery({
    queryKey: ['balance', accountId],
    queryFn: () => sorobanSDK.getBalance(accountId || ''),
    enabled: !!accountId,
    staleTime: 30000,
  })
}

export function useContractInvoke() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async ({
      contractId,
      method,
      args,
    }: {
      contractId: string
      method: string
      args: any[]
    }) => {
      return await sorobanSDK.invokeContract(contractId, method, args)
    },
    onSuccess: () => {
      toast.success('Contract invocation successful')
      queryClient.invalidateQueries({ queryKey: ['contract'] })
    },
    onError: (error) => {
      toast.error('Contract invocation failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    },
  })
}

export function useTransactionSubmit() {
  const queryClient = useQueryClient()

  return useMutation({
    mutationFn: async (transaction: any) => {
      return await sorobanSDK.submitTransaction(transaction)
    },
    onSuccess: (hash) => {
      toast.success('Transaction submitted', {
        description: `Transaction hash: ${hash}`,
      })
      queryClient.invalidateQueries({ queryKey: ['transaction'] })
    },
    onError: (error) => {
      toast.error('Transaction failed', {
        description: error instanceof Error ? error.message : 'Unknown error',
      })
    },
  })
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
