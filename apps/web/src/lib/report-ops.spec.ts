import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Whether an FBA report pull is queued or held open in the chat turn.
 *
 * `startReportJob` is OPTIONAL on the ops interface, and its presence is the
 * signal the tool reads to decide which path to take. That makes its absence a
 * behaviour, not an omission: an environment with no conversation to deliver
 * into must not advertise background delivery, because a queued job with no
 * chat would run, spend money at Amazon, and have nobody to tell.
 */

const { startReportJob } = vi.hoisted(() => ({ startReportJob: vi.fn() }));

vi.mock('./report-jobs-client', () => ({
  startReportJob: (...args: unknown[]) => startReportJob(...args),
}));

vi.mock('@amz-spapi/sp-cache', () => ({
  syncReport: vi.fn(),
  isIngestError: (r: unknown) => Boolean(r && 'error' in (r as object)),
  getCoverage: vi.fn(),
  queryLedgerRows: vi.fn(),
  queryReportAggregate: vi.fn(),
  getPayoutBreakdown: vi.fn(),
}));

vi.mock('@farvisionllc/sp-client', () => ({
  REPORT_TIMEOUT_MS: { requestSafe: 90_000, worker: 600_000 },
  SpApiClient: class {},
}));

const { createReportOps } = await import('./report-ops');

const BASE = {
  sellerId: 'A1SELLER',
  spClient: {} as never,
  marketplaceId: 'ATVPDKIKX0DER',
};

const INPUT = { kind: 'ledger-detail', from: '2026-08-01', to: '2026-08-07' };

beforeEach(() => {
  startReportJob.mockReset().mockResolvedValue({
    started: true,
    job: { jobId: 'job-1' },
  });
});

describe('when there is nowhere to deliver a result', () => {
  it('offers no background path without a chat', () => {
    const ops = createReportOps({ ...BASE, userId: 'auth0|1' });
    // Absent, not a stub that refuses: the tool branches on presence.
    expect(ops.startReportJob).toBeUndefined();
  });

  it('offers no background path without a user', () => {
    const ops = createReportOps({ ...BASE, chatId: 'chat_1' });
    expect(ops.startReportJob).toBeUndefined();
  });
});

describe('when a conversation is available', () => {
  const ops = () =>
    createReportOps({
      ...BASE,
      userId: 'auth0|1',
      chatId: 'chat_1',
      profileName: 'sp-ATVPDKIKX0DER-msi1l2wg',
    });

  it('queues the pull against the seller the ops were built for', async () => {
    const result = await ops().startReportJob?.(INPUT);

    expect(result).toEqual({ started: true, jobId: 'job-1' });
    expect(startReportJob).toHaveBeenCalledWith({
      userId: 'auth0|1',
      chatId: 'chat_1',
      sellerId: 'A1SELLER',
      kind: 'fba-report',
      request: {
        reportKind: 'ledger-detail',
        from: '2026-08-01',
        to: '2026-08-07',
        marketplaceId: 'ATVPDKIKX0DER',
        // Credentials are keyed on the profile NAME; a job without it mints
        // against an empty key and fails inside the Lambda.
        profileName: 'sp-ATVPDKIKX0DER-msi1l2wg',
      },
    });
  });

  it('carries the report kind as `reportKind`, not `kind`', async () => {
    await ops().startReportJob?.(INPUT);

    const [{ request, kind }] = startReportJob.mock.calls[0] as [
      { request: Record<string, unknown>; kind: string }
    ];
    // `kind` is the JOB kind and `reportKind` the Amazon report. Collapsing the
    // two sends the worker looking up a report type called "fba-report".
    expect(kind).toBe('fba-report');
    expect(request['reportKind']).toBe('ledger-detail');
  });

  it('passes a refusal back rather than throwing into the turn', async () => {
    startReportJob.mockResolvedValue({
      started: false,
      error: 'Background reports are not configured in this environment',
    });

    const result = await ops().startReportJob?.(INPUT);

    // The tool falls back to the in-turn path on `started: false`, so this must
    // resolve rather than reject.
    expect(result).toEqual({
      started: false,
      error: 'Background reports are not configured in this environment',
    });
  });
});
