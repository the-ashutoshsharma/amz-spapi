import { describe, expect, it, vi } from 'vitest';
import type { SpApiClient } from '@farvisionllc/sp-client';
import { collectFbaReport, requestFbaReport } from './report-sync.js';

/**
 * Splitting a report request from its collection.
 *
 * The point of the split is that the wait happens somewhere allowed to wait.
 * These cases pin the three behaviours that make that safe:
 *
 *  - requesting RETURNS the report id instead of blocking on it, so the caller
 *    can store the id before anything else can fail;
 *  - "still building" is a returned state, not a thrown error — for most of a
 *    report's life it is the correct answer, and throwing would hand a retry
 *    policy something that is going exactly to plan;
 *  - CANCELLED reads as "no data in that range", because Amazon uses it to mean
 *    that and a seller must not be told their integration broke.
 *
 * The DONE path ingests, which is covered by the ingest suites; these cases
 * deliberately stop at the storage boundary so they need no cluster.
 */

const SELLER = 'A1SELLER';
const WINDOW = { from: '2026-08-01', to: '2026-08-07' } as const;

function fakeClient(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    createReport: vi.fn(
      async (_params: {
        reportType: string;
        dataStartTime?: string;
        dataEndTime?: string;
        marketplaceIds?: string[];
        reportOptions?: Record<string, string>;
      }) => ({ reportId: 'REPORT-1' })
    ),
    getReport: vi.fn(async (_reportId: string) => ({
      processingStatus: 'IN_PROGRESS',
    })),
    getReportDocument: vi.fn(async () => ({ url: 'https://example/doc' })),
    downloadReportDocument: vi.fn(async () => 'header\nrow'),
    listReports: vi.fn(async () => ({ reports: [] })),
    ...overrides,
  };
}

/**
 * The fake keeps its mock types; the functions under test want the real
 * interface. Coercing at the call site rather than in the factory is what lets
 * assertions still read `.mock.calls`.
 */
const asClient = (client: unknown): SpApiClient => client as SpApiClient;

describe('requestFbaReport', () => {
  it('returns the report id without waiting for the report', async () => {
    const client = fakeClient();

    const result = await requestFbaReport({
      client: asClient(client),
      sellerId: SELLER,
      kind: 'ledger-detail',
      ...WINDOW,
    });

    expect(result).toEqual({ state: 'requested', reportId: 'REPORT-1' });
    // The whole point: nothing here polls. Waiting is the state machine's job.
    expect(client.getReport).not.toHaveBeenCalled();
  });

  it('sends the options the kind requires, so collection can match them', async () => {
    const client = fakeClient();

    await requestFbaReport({
      client: asClient(client),
      sellerId: SELLER,
      kind: 'ledger-detail',
      ...WINDOW,
    });

    const [sent] = client.createReport.mock.calls[0];
    // `ledger-detail` declares required options; a request built without them
    // returns a report that parses into the wrong shape rather than failing.
    expect(sent.reportOptions).toBeTruthy();
    expect(sent.dataStartTime).toContain('2026-08-01');
  });

  it('reports a refused request rather than throwing', async () => {
    const client = fakeClient({
      createReport: vi.fn(async () => {
        throw new Error('403 Access to requested resource is denied');
      }),
    });

    const result = await requestFbaReport({
      client: asClient(client),
      sellerId: SELLER,
      kind: 'ledger-detail',
      ...WINDOW,
    });

    expect(result.state).toBe('failed');
    expect(result).toMatchObject({ error: expect.stringContaining('403') });
  });
});

describe('collectFbaReport', () => {
  it('returns pending while Amazon is still building', async () => {
    const client = fakeClient();

    const result = await collectFbaReport({
      client: asClient(client),
      sellerId: SELLER,
      kind: 'ledger-detail',
      ...WINDOW,
      reportId: 'REPORT-1',
    });

    // Returned, not thrown — the state machine turns this back into a Wait.
    expect(result).toEqual({ state: 'pending', status: 'IN_PROGRESS' });
    expect(client.getReportDocument).not.toHaveBeenCalled();
  });

  it('calls a CANCELLED report an empty window, not a failure of ours', async () => {
    const client = fakeClient({
      getReport: vi.fn(async () => ({ processingStatus: 'CANCELLED' })),
    });

    const result = await collectFbaReport({
      client: asClient(client),
      sellerId: SELLER,
      kind: 'ledger-detail',
      ...WINDOW,
      reportId: 'REPORT-1',
    });

    expect(result).toEqual({
      state: 'failed',
      error: 'Amazon found no data in that date range.',
    });
  });

  it('distinguishes a FATAL report from an empty one', async () => {
    const client = fakeClient({
      getReport: vi.fn(async () => ({ processingStatus: 'FATAL' })),
    });

    const result = await collectFbaReport({
      client: asClient(client),
      sellerId: SELLER,
      kind: 'ledger-detail',
      ...WINDOW,
      reportId: 'REPORT-1',
    });

    expect(result.state).toBe('failed');
    // A seller told "no data" when Amazon actually failed would stop looking.
    expect(result).not.toMatchObject({
      error: 'Amazon found no data in that date range.',
    });
  });

  it('treats DONE with no document as still pending, not as ready', async () => {
    const client = fakeClient({
      getReport: vi.fn(async () => ({ processingStatus: 'DONE' })),
    });

    const result = await collectFbaReport({
      client: asClient(client),
      sellerId: SELLER,
      kind: 'ledger-detail',
      ...WINDOW,
      reportId: 'REPORT-1',
    });

    // Ready-without-bytes would ingest nothing and record the window as covered,
    // which reads downstream as "this seller had no activity".
    expect(result.state).toBe('pending');
  });

  it('surfaces a fetch failure instead of throwing into the state machine', async () => {
    const client = fakeClient({
      getReport: vi.fn(async () => {
        throw new Error('timeout contacting Amazon');
      }),
    });

    const result = await collectFbaReport({
      client: asClient(client),
      sellerId: SELLER,
      kind: 'ledger-detail',
      ...WINDOW,
      reportId: 'REPORT-1',
    });

    expect(result).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('timeout'),
    });
  });

  it('collects the id it is given rather than requesting a new report', async () => {
    const client = fakeClient();

    await collectFbaReport({
      client: asClient(client),
      sellerId: SELLER,
      kind: 'ledger-detail',
      ...WINDOW,
      reportId: 'REPORT-FROM-A-PREVIOUS-TURN',
    });

    // The bug this whole split exists to remove: a resumed report must never
    // become a second, separately billed request for the same window.
    expect(client.createReport).not.toHaveBeenCalled();
    expect(client.getReport).toHaveBeenCalledWith(
      'REPORT-FROM-A-PREVIOUS-TURN'
    );
  });
});
