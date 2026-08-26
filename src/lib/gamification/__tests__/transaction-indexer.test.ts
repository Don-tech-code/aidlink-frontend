/**
 * Unit tests for the gamification transaction indexer (issue #142).
 *
 * Verifies that indexTransactions decodes real payment amounts from
 * envelope_xdr instead of fee_charged, correctly classifies donation /
 * distribution / claim events from actual operation semantics, resolves
 * recipient to the real payment/invocation destination, resumes from a
 * cursor without re-fetching old pages, and never crashes on malformed
 * XDR.
 */

import {
  Account,
  Asset,
  Keypair,
  Networks,
  Operation,
  StrKey,
  TransactionBuilder,
} from '@stellar/stellar-sdk';
import { indexTransactions } from '../transaction-indexer';
import { evaluateBadge } from '../badge-evaluator';
import { BADGE_DEFINITIONS } from '../badge-rules';

const centuryClubRule = BADGE_DEFINITIONS.find((b) => b.id === 'century_club')!.rule;

interface MockHorizonTxRecord {
  id: string;
  hash: string;
  paging_token: string;
  created_at: string;
  source_account: string;
  successful?: boolean;
  envelope_xdr: string;
  fee_charged?: string;
}

function makeTxRecord(overrides: Partial<MockHorizonTxRecord> & {
  hash: string;
  source_account: string;
  envelope_xdr: string;
}): MockHorizonTxRecord {
  return {
    id: overrides.hash,
    paging_token: overrides.hash,
    created_at: '2026-08-01T12:00:00Z',
    successful: true,
    ...overrides,
  };
}

function buildPaymentEnvelopeXdr(params: {
  source: Keypair;
  destination: Keypair;
  amount: string;
  asset?: Asset;
}): string {
  const account = new Account(params.source.publicKey(), '1');
  const tx = new TransactionBuilder(account, {
    fee: '500',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.payment({
        destination: params.destination.publicKey(),
        asset: params.asset || Asset.native(),
        amount: params.amount,
      })
    )
    .setTimeout(30)
    .build();

  return tx.toEnvelope().toXDR('base64');
}

function buildInvokeContractEnvelopeXdr(params: {
  source: Keypair;
  contractId: string;
  functionName: string;
}): string {
  const account = new Account(params.source.publicKey(), '1');
  const tx = new TransactionBuilder(account, {
    fee: '500',
    networkPassphrase: Networks.TESTNET,
  })
    .addOperation(
      Operation.invokeContractFunction({
        contract: params.contractId,
        function: params.functionName,
        args: [],
      })
    )
    .setTimeout(30)
    .build();

  return tx.toEnvelope().toXDR('base64');
}

function mockFetchOnce(response: unknown, ok = true) {
  (global.fetch as jest.Mock).mockResolvedValueOnce({
    ok,
    json: async () => response,
  });
}

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.resetAllMocks();
});

describe('indexTransactions', () => {
  it('decodes the real payment amount from envelope_xdr instead of fee_charged', async () => {
    const donor = Keypair.random();
    const campaign = Keypair.random();

    const envelopeXdr = buildPaymentEnvelopeXdr({
      source: donor,
      destination: campaign,
      amount: '100',
    });

    mockFetchOnce({
      _embedded: {
        records: [
          makeTxRecord({
            hash: 'tx1',
            source_account: donor.publicKey(),
            envelope_xdr: envelopeXdr,
            fee_charged: '100', // 0.00001 XLM — must NOT be used as the amount
          }),
        ],
      },
    });

    const { events } = await indexTransactions(donor.publicKey());

    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(100);
    expect(events[0].type).toBe('donation');
    expect(events[0].currency).toBe('XLM');
    expect(events[0].recipient).toBe(campaign.publicKey());
  });

  it('classifies an invokeHostFunction "claim" call as type claim, not donation', async () => {
    const claimant = Keypair.random();
    const contractId = StrKey.encodeContract(Buffer.alloc(32, 7));

    const envelopeXdr = buildInvokeContractEnvelopeXdr({
      source: claimant,
      contractId,
      functionName: 'claim',
    });

    mockFetchOnce({
      _embedded: {
        records: [
          makeTxRecord({
            hash: 'tx-claim',
            source_account: claimant.publicKey(),
            envelope_xdr: envelopeXdr,
          }),
        ],
      },
    });

    const { events } = await indexTransactions(claimant.publicKey());

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('claim');
    expect(events[0].recipient).toBe(contractId);

    // The badge evaluator only sums events with type === 'donation', so a
    // claim must never contribute to total_donated_amount.
    const result = evaluateBadge(centuryClubRule, events);
    expect(result.progress).toBe(0);
    expect(result.unlocked).toBe(false);
  });

  it('uses the XDR-decoded payment amount even when fee_charged reflects a tiny network fee', async () => {
    const donor = Keypair.random();
    const campaign = Keypair.random();

    const envelopeXdr = buildPaymentEnvelopeXdr({
      source: donor,
      destination: campaign,
      amount: '1000',
    });

    mockFetchOnce({
      _embedded: {
        records: [
          makeTxRecord({
            hash: 'tx-big-donation',
            source_account: donor.publicKey(),
            envelope_xdr: envelopeXdr,
            fee_charged: '500', // 0.00005 XLM fee
          }),
        ],
      },
    });

    const { events } = await indexTransactions(donor.publicKey());

    expect(events).toHaveLength(1);
    expect(events[0].amount).toBe(1000);
    expect(events[0].amount).not.toBe(0.00005);
  });

  it('resumes from a cursor and issues exactly one Horizon call when there are no new transactions', async () => {
    const donor = Keypair.random();
    const campaign = Keypair.random();

    const envelopeXdr = buildPaymentEnvelopeXdr({
      source: donor,
      destination: campaign,
      amount: '10',
    });

    mockFetchOnce({
      _embedded: {
        records: [
          makeTxRecord({
            hash: 'tx1',
            paging_token: 'cursor-1',
            source_account: donor.publicKey(),
            envelope_xdr: envelopeXdr,
          }),
        ],
      },
    });

    const first = await indexTransactions(donor.publicKey());
    expect(first.cursor).toBe('cursor-1');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    jest.clearAllMocks();

    mockFetchOnce({ _embedded: { records: [] } });

    const second = await indexTransactions(donor.publicKey(), undefined, {
      cursor: first.cursor,
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(second.events).toEqual([]);
  });

  it('classifies a custom AID token payment with currency AID, not XLM', async () => {
    const donor = Keypair.random();
    const campaign = Keypair.random();
    const issuer = Keypair.random();
    const aidAsset = new Asset('AID', issuer.publicKey());

    const envelopeXdr = buildPaymentEnvelopeXdr({
      source: donor,
      destination: campaign,
      amount: '50',
      asset: aidAsset,
    });

    mockFetchOnce({
      _embedded: {
        records: [
          makeTxRecord({
            hash: 'tx-aid',
            source_account: donor.publicKey(),
            envelope_xdr: envelopeXdr,
          }),
        ],
      },
    });

    const { events } = await indexTransactions(donor.publicKey());

    expect(events).toHaveLength(1);
    expect(events[0].currency).toBe('AID');
    expect(events[0].amount).toBe(50);
  });

  it('skips a transaction with undecodable envelope_xdr instead of crashing', async () => {
    const donor = Keypair.random();

    mockFetchOnce({
      _embedded: {
        records: [
          makeTxRecord({
            hash: 'tx-garbage',
            source_account: donor.publicKey(),
            envelope_xdr: Buffer.from('not a real xdr envelope, just noise').toString('base64'),
          }),
        ],
      },
    });

    await expect(indexTransactions(donor.publicKey())).resolves.toEqual({
      events: [],
      cursor: 'tx-garbage',
    });
  });

  it('produces distinct donation events for three outgoing payments and excludes incoming payments', async () => {
    const donor = Keypair.random();
    const campaignA = Keypair.random();
    const campaignB = Keypair.random();
    const refunder = Keypair.random();

    const records = [
      makeTxRecord({
        hash: 'tx-10',
        paging_token: 'p1',
        source_account: donor.publicKey(),
        envelope_xdr: buildPaymentEnvelopeXdr({
          source: donor,
          destination: campaignA,
          amount: '10',
        }),
      }),
      makeTxRecord({
        hash: 'tx-20',
        paging_token: 'p2',
        source_account: donor.publicKey(),
        envelope_xdr: buildPaymentEnvelopeXdr({
          source: donor,
          destination: campaignB,
          amount: '20',
        }),
      }),
      makeTxRecord({
        hash: 'tx-30',
        paging_token: 'p3',
        source_account: donor.publicKey(),
        envelope_xdr: buildPaymentEnvelopeXdr({
          source: donor,
          destination: campaignA,
          amount: '30',
        }),
      }),
      // Incoming payment to the donor — must not be treated as a donation.
      makeTxRecord({
        hash: 'tx-incoming',
        paging_token: 'p4',
        source_account: refunder.publicKey(),
        envelope_xdr: buildPaymentEnvelopeXdr({
          source: refunder,
          destination: donor,
          amount: '999',
        }),
      }),
    ];

    mockFetchOnce({ _embedded: { records } });

    const { events } = await indexTransactions(donor.publicKey());

    const donations = events.filter((e) => e.type === 'donation');
    expect(donations.map((e) => e.amount).sort((a, b) => a - b)).toEqual([10, 20, 30]);

    const distributions = events.filter((e) => e.type === 'distribution');
    expect(distributions).toHaveLength(1);
    expect(distributions[0].amount).toBe(999);

    let result = evaluateBadge(centuryClubRule, events);
    expect(result.unlocked).toBe(false); // 10 + 20 + 30 = 60 < 100

    const fourthPayment = makeTxRecord({
      hash: 'tx-50',
      paging_token: 'p5',
      source_account: donor.publicKey(),
      envelope_xdr: buildPaymentEnvelopeXdr({
        source: donor,
        destination: campaignA,
        amount: '50',
      }),
    });

    result = evaluateBadge(centuryClubRule, [
      ...events,
      ...(await (async () => {
        jest.clearAllMocks();
        mockFetchOnce({ _embedded: { records: [fourthPayment] } });
        const { events: moreEvents } = await indexTransactions(donor.publicKey());
        return moreEvents;
      })()),
    ]);
    expect(result.unlocked).toBe(true); // 60 + 50 = 110 >= 100
  });
});

describe('evaluateBadge integration with real events', () => {
  it('unlocks century_club at progress 125 for 5 donations of 25 XLM each', () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      txHash: `tx-${i}`,
      timestamp: new Date(`2026-08-0${i + 1}T00:00:00Z`),
      type: 'donation' as const,
      amount: 25,
      currency: 'XLM',
      recipient: 'GCAMPAIGN',
    }));

    const result = evaluateBadge(centuryClubRule, events);

    expect(result.unlocked).toBe(true);
    expect(result.progress).toBe(125);
  });
});
