import { encodeMuxedAccountToAddress, StrKey, xdr } from '@stellar/stellar-sdk'

export const STROOPS_PER_XLM = 10_000_000

export function stroopsToXlm(stroops: string | number | bigint): number {
  return Number(stroops) / STROOPS_PER_XLM
}

/**
 * Classifies a Soroban contract function name into a coarse transaction
 * type. Shared between the dashboard's real-time stream and the
 * gamification indexer so both agree on what counts as a "claim" call.
 */
export function mapSorobanFunctionName(
  functionName: string
): 'donation' | 'distribution' | 'claim' | 'refund' {
  const name = functionName.toLowerCase()
  if (name.includes('claim')) return 'claim'
  if (name.includes('refund')) return 'refund'
  if (name.includes('distribut')) return 'distribution'
  if (name.includes('donate') || name.includes('donation') || name.includes('fund')) {
    return 'donation'
  }
  return 'donation'
}

/**
 * Decodes a base64 TransactionEnvelope XDR string (v0, v1, or fee-bump)
 * into its list of operations. Throws if the XDR cannot be parsed;
 * callers should wrap this in a try/catch and skip the transaction.
 */
export function getEnvelopeOperations(envelopeXdr: string): xdr.Operation[] {
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

export function contractIdFromAddress(address: xdr.ScAddress): string {
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

function sourceAccountOf(
  op: xdr.Operation,
  fallbackSourceAccount: string
): string {
  return op.sourceAccount() != null
    ? encodeMuxedAccountToAddress(op.sourceAccount()!, true)
    : fallbackSourceAccount
}

/** Returns 'XLM' for the native asset, otherwise the trimmed asset code (e.g. 'AID'). */
export function assetCodeOf(asset: xdr.Asset): string {
  const type = asset.switch().name
  try {
    if (type === 'assetTypeNative') {
      return 'XLM'
    }
    if (type === 'assetTypeCreditAlphanum4') {
      return asset.alphaNum4().assetCode().toString('ascii').replace(/\0+$/, '')
    }
    if (type === 'assetTypeCreditAlphanum12') {
      return asset.alphaNum12().assetCode().toString('ascii').replace(/\0+$/, '')
    }
  } catch {
    // fall through
  }
  return 'UNKNOWN'
}

export interface DecodedPaymentOp {
  source: string
  destination: string
  amount: number
  /** 'XLM' for native, otherwise the asset code (e.g. 'AID'). */
  assetCode: string
}

/**
 * Decodes a `payment` operation into its source, destination, amount (in
 * whole XLM/asset units, not stroops), and asset code. Returns null if the
 * operation is not a payment.
 */
export function decodePaymentOp(
  op: xdr.Operation,
  fallbackSourceAccount: string
): DecodedPaymentOp | null {
  const body = op.body()
  if (body.switch() !== xdr.OperationType.payment()) {
    return null
  }

  const payment = body.paymentOp()
  const destination = encodeMuxedAccountToAddress(payment.destination(), true)
  const source = sourceAccountOf(op, fallbackSourceAccount)
  const amount = stroopsToXlm(payment.amount().toString())

  return { source, destination, amount, assetCode: assetCodeOf(payment.asset()) }
}

export interface DecodedInvokeHostFunctionOp {
  source: string
  functionName: string
  contractId: string
  type: 'donation' | 'distribution' | 'claim' | 'refund'
}

/**
 * Decodes an `invokeHostFunction` operation that calls a contract function
 * (e.g. `claim`, `distribute`). Returns null if the operation is not an
 * invokeHostFunction, or not a contract invocation.
 */
export function decodeInvokeHostFunctionOp(
  op: xdr.Operation,
  fallbackSourceAccount: string
): DecodedInvokeHostFunctionOp | null {
  const body = op.body()
  if (body.switch() !== xdr.OperationType.invokeHostFunction()) {
    return null
  }

  const invokeOp = body.invokeHostFunctionOp()
  const hostFn = invokeOp.hostFunction()

  if (hostFn.switch() !== xdr.HostFunctionType.hostFunctionTypeInvokeContract()) {
    return null
  }

  const invoke = hostFn.invokeContract()
  const functionName = invoke.functionName().toString()
  const contractId = contractIdFromAddress(invoke.contractAddress())
  const source = sourceAccountOf(op, fallbackSourceAccount)

  return {
    source,
    functionName,
    contractId,
    type: mapSorobanFunctionName(functionName),
  }
}
