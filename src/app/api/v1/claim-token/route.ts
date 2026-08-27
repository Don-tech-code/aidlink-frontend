/**
 * POST /api/v1/claim-token
 *
 * Issues a signed claim token for a single allocation.
 *
 * The HMAC signing secret is read and used ONLY on the server, inside
 * `claim-token.server.ts` (which is `import 'server-only'`), so it can never be
 * bundled into the browser. The beneficiary portal (AllocationCard) calls this
 * route to obtain the base64url token it renders as a QR code — replacing the
 * previous client-side generation that required the secret in the client bundle.
 *
 * Request body:
 *   {
 *     claimId: string,
 *     beneficiaryAddress: string,
 *     campaignId: string,
 *     allocatedAmountStroops: string | number,
 *     ttlSeconds?: number
 *   }
 *
 * Response:
 *   200 { token: string }
 *   400 { error: string }   — malformed request
 *   500 { error: string }   — signing failed (e.g. CLAIM_TOKEN_SECRET unset in prod)
 */

import { NextResponse } from 'next/server'
import { generateClaimToken } from '@/lib/beneficiary/claim-token.server'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(request: Request) {
  let body: Record<string, unknown>
  try {
    body = (await request.json()) as Record<string, unknown>
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })
  }

  const { claimId, beneficiaryAddress, campaignId, allocatedAmountStroops, ttlSeconds } = body

  if (
    typeof claimId !== 'string' ||
    typeof beneficiaryAddress !== 'string' ||
    typeof campaignId !== 'string' ||
    (typeof allocatedAmountStroops !== 'string' &&
      typeof allocatedAmountStroops !== 'number')
  ) {
    return NextResponse.json(
      { error: 'Missing or invalid claim fields.' },
      { status: 400 },
    )
  }

  try {
    const token = await generateClaimToken(
      claimId,
      beneficiaryAddress,
      campaignId,
      allocatedAmountStroops,
      typeof ttlSeconds === 'number' ? ttlSeconds : undefined,
    )
    return NextResponse.json(
      { token },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    console.error('[claim-token] token generation failed:', err)
    return NextResponse.json(
      { error: 'Failed to generate claim token.' },
      { status: 500 },
    )
  }
}
