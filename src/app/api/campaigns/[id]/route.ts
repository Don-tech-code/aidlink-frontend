import { NextRequest, NextResponse } from 'next/server'
import { fetchCampaignById } from '@/lib/campaigns/data'

/**
 * Single-campaign detail endpoint (issue #98), backing the
 * /campaigns/[id] page's useCampaign(id) hook. Not found is a normal
 * 200 with `{ campaign: null }` rather than a 404 — the caller
 * distinguishes "no such campaign" from "the fetch itself failed" the
 * same way useCampaigns already does for the list endpoint.
 */
export async function GET(_request: NextRequest, { params }: { params: { id: string } }) {
  const campaign = await fetchCampaignById(params.id)
  return NextResponse.json({ campaign })
}
