import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimDelivery,
  completeReportJob,
  createReportJob,
  failReportJob,
  markJobBuilding,
  pendingJobsForChat,
  reportJobStorage,
  undeliveredFinishedJobs,
  type ReportJob,
} from './report-jobs.js';

/**
 * The paperwork that lets a report outlive the chat turn that asked for it.
 *
 * Two properties are worth pinning, because both regressions are silent:
 *
 *  - `markJobBuilding` must persist Amazon's report id. Losing it is what made
 *    a slow report into a rebuilt one, and a rebuild looks like success — it
 *    returns the right rows, just after paying Amazon twice and waiting again.
 *  - `claimDelivery` must succeed exactly once. A second winner posts a second
 *    identical message into the conversation, which reads as a bug in the
 *    agent rather than in the delivery path.
 *
 * All I/O goes through the `reportJobStorage` seam, so none of this needs a
 * cluster.
 */

const USER = 'auth0|jobs-test';
const CHAT = 'chat-abc';
const SELLER = 'A1SELLER';

/** In-memory stand-in for the collection, keyed the way the module keys it. */
function fakeStore() {
  const docs = new Map<string, unknown>();
  return {
    docs,
    getDocument: vi.fn(async (_s: string, _c: string, key: string) =>
      docs.has(key) ? structuredClone(docs.get(key)) : null
    ),
    upsertDocument: vi.fn(
      async (_s: string, _c: string, key: string, doc: unknown) => {
        docs.set(key, structuredClone(doc));
      }
    ),
    // Insert-if-absent, which is the whole basis of the delivery claim.
    insertDocument: vi.fn(
      async (_s: string, _c: string, key: string, doc: unknown) => {
        if (docs.has(key)) return false;
        docs.set(key, structuredClone(doc));
        return true;
      }
    ),
    executeQuery: vi.fn(
      async (
        _domain: string,
        _statement: string,
        _options?: { parameters?: Record<string, unknown>; readonly?: boolean }
      ) => ({ rows: [] as ReportJob[] })
    ),
  };
}

describe('report jobs', () => {
  let original: typeof reportJobStorage;
  let store: ReturnType<typeof fakeStore>;

  beforeEach(() => {
    original = { ...reportJobStorage };
    store = fakeStore();
    Object.assign(reportJobStorage, store);
  });

  afterEach(() => {
    Object.assign(reportJobStorage, original);
  });

  it('creates a job as queued and addressed to a chat', async () => {
    const job = await createReportJob({
      userId: USER,
      chatId: CHAT,
      sellerId: SELLER,
      kind: 'ads-performance',
      request: { level: 'campaign', startDate: '2026-08-01' },
    });

    expect(job.status).toBe('queued');
    expect(job.chatId).toBe(CHAT);
    expect(job.amazonReportId).toBeUndefined();
    // A TTL is passed, so these never become a collection anyone must prune.
    expect(store.upsertDocument).toHaveBeenCalledWith(
      'ops',
      'report_jobs',
      `job::${job.jobId}`,
      expect.objectContaining({ jobId: job.jobId }),
      expect.any(Number)
    );
  });

  it('persists the Amazon report id as soon as the report is building', async () => {
    const job = await createReportJob({
      userId: USER,
      chatId: CHAT,
      sellerId: SELLER,
      kind: 'fba-report',
      request: { kind: 'ledger-detail' },
    });

    const building = await markJobBuilding(job.jobId, 'AMZN-REPORT-1');

    expect(building?.status).toBe('building');
    // The field whose loss forced Amazon to rebuild the same report.
    expect(building?.amazonReportId).toBe('AMZN-REPORT-1');
    expect(store.docs.get(`job::${job.jobId}`)).toMatchObject({
      amazonReportId: 'AMZN-REPORT-1',
    });
  });

  it('records success and failure in the words the chat will use', async () => {
    const ok = await createReportJob({
      userId: USER,
      chatId: CHAT,
      sellerId: SELLER,
      kind: 'fba-report',
      request: {},
    });
    const bad = await createReportJob({
      userId: USER,
      chatId: CHAT,
      sellerId: SELLER,
      kind: 'fba-report',
      request: {},
    });

    expect((await completeReportJob(ok.jobId, '412 new rows'))?.summary).toBe(
      '412 new rows'
    );
    expect((await failReportJob(bad.jobId, 'no data in range'))?.error).toBe(
      'no data in range'
    );
    expect((await failReportJob(bad.jobId, 'no data in range'))?.status).toBe(
      'failed'
    );
  });

  it('lets exactly one caller deliver a job', async () => {
    const job = await createReportJob({
      userId: USER,
      chatId: CHAT,
      sellerId: SELLER,
      kind: 'ads-performance',
      request: {},
    });
    await completeReportJob(job.jobId, 'done');

    const first = await claimDelivery(job.jobId, USER);
    const second = await claimDelivery(job.jobId, USER);
    const third = await claimDelivery(job.jobId, USER);

    expect(first).toBe(true);
    // A Step Functions retry and a reconnecting tab both land here.
    expect(second).toBe(false);
    expect(third).toBe(false);
  });

  it('marks the job delivered so a later read stops offering it', async () => {
    const job = await createReportJob({
      userId: USER,
      chatId: CHAT,
      sellerId: SELLER,
      kind: 'ads-performance',
      request: {},
    });
    await claimDelivery(job.jobId, USER);

    expect(store.docs.get(`job::${job.jobId}`)).toMatchObject({
      deliveredAt: expect.any(Number),
    });
  });

  it('returns nothing to deliver when the claim was already taken', async () => {
    const job = await createReportJob({
      userId: USER,
      chatId: CHAT,
      sellerId: SELLER,
      kind: 'ads-performance',
      request: {},
    });
    // Simulate a competing deliverer that got there first.
    await reportJobStorage.insertDocument(
      'ops',
      'report_jobs',
      `claim::${job.jobId}`,
      { jobId: job.jobId },
      1
    );

    expect(await claimDelivery(job.jobId, USER)).toBe(false);
  });

  it('asks only for this chat, undelivered, oldest first', async () => {
    await pendingJobsForChat({ userId: USER, chatId: CHAT });

    const [, statement, options] = store.executeQuery.mock.calls[0];
    expect(statement).toContain('deliveredAt IS MISSING');
    expect(statement).toContain('ORDER BY job.createdAt ASC');
    expect(options?.parameters).toMatchObject({ userId: USER, chatId: CHAT });
    expect(options?.readonly).toBe(true);
  });

  it('treats only finished jobs as deliverable', async () => {
    const rows: ReportJob[] = [
      { status: 'queued' } as ReportJob,
      { status: 'building' } as ReportJob,
      { status: 'ready', summary: 's' } as ReportJob,
      { status: 'failed', error: 'e' } as ReportJob,
    ];
    store.executeQuery.mockResolvedValueOnce({ rows });

    const deliverable = await undeliveredFinishedJobs({
      userId: USER,
      chatId: CHAT,
    });

    // A job still building is owed to the chat but has nothing to say yet.
    expect(deliverable.map((job) => job.status)).toEqual(['ready', 'failed']);
  });
});
