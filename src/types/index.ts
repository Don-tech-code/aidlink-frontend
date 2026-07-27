export interface WalletState {
  isConnected: boolean
  address: string | null
  publicKey: string | null
  network: 'mainnet' | 'testnet' | 'futurenet' | 'standalone'
  balance: string
}

export interface Campaign {
  id: string
  title: string
  description: string
  targetAmount: number
  raisedAmount: number
  currency: string
  status: 'active' | 'completed' | 'paused' | 'pending'
  ngoId: string
  ngoName: string
  createdAt: string
  endDate: string
  category: 'emergency' | 'healthcare' | 'education' | 'food' | 'shelter' | 'other'
  imageUrl?: string
  beneficiaries: Beneficiary[]
}

export type VerificationStatus = 'unverified' | 'pending' | 'verified' | 'rejected'

export interface ProofObject {
  type: 'on-chain' | 'signed'
  identifier?: string
  transactionHash?: string
  fileName?: string
  submittedBy?: string
}

export interface Beneficiary {
  id: string
  name: string
  walletAddress: string
  status: 'verified' | 'pending' | 'suspended'
  verificationStatus: VerificationStatus
  verificationProof?: string | ProofObject
  verificationReason?: string
  verificationSubmittedAt?: string
  verificationRejectedAt?: string
  campaignId: string
  allocatedAmount: number
  claimedAmount: number
  verificationDocuments?: string[]
  location: {
    country: string
    region: string
    city: string
  }
  createdAt: string
}

export interface Transaction {
  id: string
  type: 'donation' | 'distribution' | 'claim' | 'refund'
  from: string
  to: string
  amount: number
  currency: string
  campaignId?: string
  beneficiaryId?: string
  status: 'pending' | 'completed' | 'failed'
  timestamp: string
  txHash?: string
}

export interface User {
  id: string
  walletAddress: string
  role: 'donor' | 'ngo' | 'beneficiary' | 'admin'
  name: string
  email?: string
  createdAt: string
  kycStatus?: 'pending' | 'verified' | 'rejected'
}

export interface Analytics {
  totalDonations: number
  totalCampaigns: number
  totalBeneficiaries: number
  activeCampaigns: number
  distributionRate: number
  monthlyDonations: { month: string; amount: number }[]
  categoryDistribution: { category: string; amount: number }[]
}

// ---------------------------------------------------------------------------
// Beneficiary claim engine types
// ---------------------------------------------------------------------------

/**
 * An allocation record returned by the BENEFICIARY_REGISTRY contract's
 * `get_allocations` function.  Amount values are in XLM stroops (integer).
 */
export interface Allocation {
  /** Unique identifier for this allocation within the contract */
  claimId: string
  /** Campaign this allocation belongs to */
  campaignId: string
  /** Campaign display name */
  campaignName: string
  /** Allocated amount in XLM stroops (1 XLM = 10,000,000 stroops) */
  allocatedAmountStroops: bigint
  /** Whether this allocation has already been claimed */
  isClaimed: boolean
  /** ISO-8601 timestamp when the allocation was created */
  createdAt: string
  /** ISO-8601 expiry for the allocation itself (not the token), if set */
  expiresAt?: string
}

/**
 * The structured payload encoded in the QR code shown to the beneficiary.
 *
 * This is NOT a raw wallet address — it is a claim-specific signed envelope.
 * Decoding the QR payload and parsing the JSON yields this object.
 */
export interface ClaimTokenPayload {
  /** Allocation ID being claimed */
  claimId: string
  /** Stellar public key of the intended claimant */
  beneficiaryAddress: string
  /** Campaign the allocation belongs to */
  campaignId: string
  /** Allocated amount in XLM stroops */
  allocatedAmount: bigint | string // bigint serialises to string in JSON
  /** Unix timestamp (seconds) when this token expires */
  exp: number
  /** HMAC-SHA256 signature over the canonical fields, hex-encoded */
  sig: string
}

/**
 * Result of validating a claim token payload against the connected wallet.
 */
export type ClaimTokenValidation =
  | { valid: true; payload: ClaimTokenPayload }
  | { valid: false; reason: 'expired' | 'wrong-address' | 'invalid-signature' | 'malformed'; message: string }

/**
 * All possible states the claim state machine can be in for a single allocation.
 */
export type ClaimStatus =
  | 'idle'
  | 'fetching-fee'
  | 'awaiting-confirmation'
  | 'signing'
  | 'submitting'
  | 'polling'
  | 'success'
  | 'error'
  | 'already-claimed'
  | 'token-expired'
  | 'not-your-claim'

/**
 * The shape of per-allocation claim state tracked by useClaim.
 */
export interface ClaimState {
  status: ClaimStatus
  /** Estimated fee in XLM (derived from minResourceFee, converted from stroops) */
  estimatedFeeXlm: number | null
  /** 64-char hex Stellar tx hash, set on SUCCESS */
  txHash: string | null
  /** User-friendly error message, set on error states */
  error: string | null
}
