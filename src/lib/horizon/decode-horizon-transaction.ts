import {
  encodeMuxedAccountToAddress,
  StrKey,
  xdr,
  type Horizon,
} from '@stellar/stellar-sdk'

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

const STROOPS_PER_XLM = 10_000_000

function stroopsToXlm(stroops: string | number | bigint): number {
  return Number(stroops) / STROOPS_PER_XLM
}

function mapSorobanFunctionName(
  functionName: string
): RealtimeTransaction['type'] {
  const name = functionName.toLowerCase()
  if (name.includes('claim')) return 'claim'
  if (name.includes('refund')) return 'refund'
  if (name.includes('distribut')) return 'distribution'
  if (name.includes('donate') || name.includes('donation') || name.includes('fund')) {
    return 'donation'
  }
  return 'donation'
}

function getEnvelopeOperations(
  envelopeXdr: string
): xdr.Operation[] {
  const envelope = xdr.TransactionEnvelope.fromXDR(envelopeXdr, 'base64')
  switch (envelope.switch()) {
    case xdr.EnvelopeType.envelopeTypeTx():
      return envelope.v1().tx().operations()
    case xdr.EnvelopeType.envelopeTypeTxV0():
      return envelope.v0().tx().operations()
    case xdr.EnvelopeType.envelopeTypeTxFeeBump(): {
      const inner = envelope.feeBump().tx().innerTx()
      if (inner.switch() === xdr.EnvelopeType.envelopeTypeTx()) {
        return inner.v1().tx().operations()
      }
      return []
    }
    default:
      return []
  }
}

function contractIdFromAddress(address: xdr.ScAddress): string {
  try {
    if (address.switch() === xdr.ScAddressType.scAddressTypeContract()) {
      return StrKey.encodeContract(address.contractId())
    }
    if (address.switch() === xdr.ScAddressType.scAddressTypeAccount()) {
      const accountId = address.accountId()
      if (accountId.switch() === xdr.PublicKeyType.publicKeyTypeEd25519()) {
        return StrKey.encodeEd25519PublicKey(accountId.ed25519())
      }
    }
  } catch {
    // fall through
  }
  return 'unknown-contract'
}

function decodeInvokeHostFunction(
  op: xdr.Operation,
  connectedPublicKey: string,
  tx: HorizonTransactionRecord,
  opIndex: number
): RealtimeTransaction | null {
  const body = op.body()
  if (body.switch() !== xdr.OperationType.invokeHostFunction()) {
    return null
  }

  const invokeOp = body.invokeHostFunctionOp()
  const hostFn = invokeOp.hostFunction()

  let functionName = 'invoke'
  let contractId = 'unknown-contract'

  if (hostFn.switch() === xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    const invoke = hostFn.invokeContract()
    functionName = invoke.functionName().toString()
    contractId = contractIdFromAddress(invoke.contractAddress())
  }

  const type = mapSorobanFunctionName(functionName)
  const source =
    op.sourceAccount() != null
      ? encodeMuxedAccountToAddress(op.sourceAccount()!, true)
      : tx.source_account

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

function decodePaymentOperation(
  op: xdr.Operation,
  connectedPublicKey: string,
  tx: HorizonTransactionRecord,
  opIndex: number
): RealtimeTransaction | null {
  const body = op.body()
  if (body.switch() !== xdr.OperationType.payment()) {
    return null
  }

  const payment = body.paymentOp()
  const destination = encodeMuxedAccountToAddress(payment.destination(), true)
  const source =
    op.sourceAccount() != null
      ? encodeMuxedAccountToAddress(op.sourceAccount()!, true)
      : tx.source_account

  const amount = stroopsToXlm(payment.amount().toString())
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
      const payment = decodePaymentOperation(
        op,
        connectedPublicKey,
        tx,
        opIndex
      )
      if (payment) {
        results.push(payment)
        return
      }

      const invoke = decodeInvokeHostFunction(
        op,
        connectedPublicKey,
        tx,
        opIndex
      )
      if (invoke) {
        results.push(invoke)
      }
    } catch {
      // Skip malformed operations rather than failing the whole stream.
    }
  })

  return results
}
