import { type Horizon, type xdr } from '@stellar/stellar-sdk'
import {
  decodeInvokeHostFunctionOp,
  decodePaymentOp,
  getEnvelopeOperations,
} from './envelope-decode'

/**
 * Dashboard-facing transaction shape used by `useRealTimeTransactions`.
 * Kept local to the hook module contract so the dashboard continues to work
 * with `Date` timestamps (see `tx.timestamp.toLocaleDateString()`).
 */
export interface RealtimeTransaction {
  id: string
  type: 'donation' | 'distribution' | 'claim' | 'refund'
  to: string
  amount: number
  status: 'pending' | 'completed' | 'failed'
  timestamp: Date
  txHash?: string
}

export type HorizonTransactionRecord = Horizon.ServerApi.TransactionRecord

function decodePaymentOperation(
  op: xdr.Operation,
  connectedPublicKey: string,
  tx: HorizonTransactionRecord,
  opIndex: number
): RealtimeTransaction | null {
  const decoded = decodePaymentOp(op, tx.source_account)
  if (!decoded) {
    return null
  }

  const { source, destination, amount } = decoded
  const isIncoming = destination === connectedPublicKey
  const isOutgoing = source === connectedPublicKey

  // Skip ops unrelated to the connected account when we can tell.
  if (!isIncoming && !isOutgoing) {
    return null
  }

  return {
    id: `${tx.hash}-${opIndex}`,
    type: isIncoming ? 'donation' : 'distribution',
    // Counterparty for the dashboard "To" column.
    to: isIncoming ? source : destination,
    amount,
    status: tx.successful === false ? 'failed' : 'completed',
    timestamp: new Date(tx.created_at),
    txHash: tx.hash,
  }
}

function decodeInvokeHostFunction(
  op: xdr.Operation,
  connectedPublicKey: string,
  tx: HorizonTransactionRecord,
  opIndex: number
): RealtimeTransaction | null {
  const decoded = decodeInvokeHostFunctionOp(op, tx.source_account)
  if (!decoded) {
    return null
  }

  const { source, contractId, type } = decoded
  const isOutgoing = source === connectedPublicKey

  return {
    id: `${tx.hash}-${opIndex}`,
    type: isOutgoing && type === 'donation' ? 'distribution' : type,
    to: contractId,
    amount: 0,
    status: tx.successful === false ? 'failed' : 'completed',
    timestamp: new Date(tx.created_at),
    txHash: tx.hash,
  }
}

/**
 * Decode a Horizon transaction record into zero or more app transactions.
 * Enumerates payment and Soroban invokeHostFunction operations from the envelope XDR.
 */
export function decodeHorizonTransaction(
  tx: HorizonTransactionRecord,
  connectedPublicKey: string
): RealtimeTransaction[] {
  if (!tx.envelope_xdr) {
    return []
  }

  let operations: xdr.Operation[] = []
  try {
    operations = getEnvelopeOperations(tx.envelope_xdr)
  } catch {
    return []
  }

  const results: RealtimeTransaction[] = []

  operations.forEach((op, opIndex) => {
    try {
      const payment = decodePaymentOperation(op, connectedPublicKey, tx, opIndex)
      if (payment) {
        results.push(payment)
        return
      }

      const invoke = decodeInvokeHostFunction(op, connectedPublicKey, tx, opIndex)
      if (invoke) {
        results.push(invoke)
      }
    } catch {
      // Skip malformed operations rather than failing the whole stream.
    }
  })

  return results
}
