/**
 * POST /api/v1/claim-token/validate
 *
 * Verifies a claim token and returns a {@link ClaimTokenValidation} result.
 *
 * Signature verification requires the server-only HMAC secret (see
 * `claim-token.server.ts`, which is `import 'server-only'`), so it cannot run
 * in the browser. The `useClaim` hook POSTs the scanned/embedded token here
 * during `startClaim()` before building any transaction.
 *
 * A token that fails validation is NOT an HTTP error — it is a normal result,
 * so validation outcomes are returned with HTTP 200 and the caller inspects
 * `result.valid`. HTTP 500 is reserved for unexpected server faults (e.g.
 * CLAIM_TOKEN_SECRET unset in production).
 *
 * Request body:  { token: string, connectedAddress: string }
 * Response:      200 ClaimTokenValidation | 500 { error: string }
 */

import { NextResponse } from 'next/server'
import { validateClaimToken } from '@/lib/beneficiary/claim-token.server'
import type { ClaimTokenValidation } from '@/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    const result: ClaimTokenValidation = {
      valid: false,
      reason: 'malformed',
      message: 'The claim token could not be decoded. Please refresh the page.',
    }
    return NextResponse.json(result, { status: 200 })
  }

  const { token, connectedAddress } = body

  if (typeof token !== 'string' || typeof connectedAddress !== 'string') {
    const result: ClaimTokenValidation = {
      valid: false,
      reason: 'malformed',
      message: 'The claim token is missing required fields. Please refresh the page.',
    }
    return NextResponse.json(result, { status: 200 })
  }

  try {
    const result = await validateClaimToken(token, connectedAddress)
    return NextResponse.json(result, {
      status: 200,
      headers: { 'Cache-Control': 'no-store' },
    })
  } catch (err) {
    console.error('[claim-token] token validation failed:', err)
    return NextResponse.json(
      { error: 'Failed to validate claim token.' },
      { status: 500 },
    )
  }
}
