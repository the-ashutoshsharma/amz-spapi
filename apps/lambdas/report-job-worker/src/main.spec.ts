import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * One step of a chat-initiated report.
 *
 * What is worth pinning here is not the happy path — it is that **every** way a
 * step can end leaves a mark on the job document. The job doc is the only thing
 * the chat ever reads, so a step that throws, or that runs against a job that
 * has expired, must not leave the conversation showing "still building" for
 * ever. Silence and progress look identical to a person who is waiting.
 */

const secrets = vi.hoisted(() => ({
  useSecretsManagerConnection: vi.fn(),
  mintSellerAccessToken: vi.fn(async () => 'token'),
}));

const jobs = vi.hoisted(() => ({
  getReportJob: vi.fn(),
  markJobBuilding: vi.fn(async () => null),
  completeReportJob: vi.fn(async () => null),
  failReportJob: vi.fn(async () => null),
  requestFbaReport: vi.fn(),
  collectFbaReport: vi.fn(),
  adsRowsAsCsv: vi.fn(() => 'header\nrow'),
  ingestReportBuffer: vi.fn(async () => ({
    rowsNew: 1240,
    rowsDuplicate: 0,
    rowsRefreshed: 0,
  })),
  isIngestError: vi.fn((r: unknown) => Boolean(r && 'error' in (r as object))),
  writeAdsRun: vi.fn(async () => ({})),
}));

const adsClient = vi.hoisted(() => ({
  requestPerformanceReport: vi.fn(),
  fetchPerformanceReport: vi.fn(),
}));

vi.mock('@amz-spapi/aws-secrets', () => secrets);
vi.mock('@amz-spapi/sp-cache', () => jobs);
vi.mock('@farvisionllc/ad-client', () => ({
  AmazonAdsApiClient: vi.fn(() => adsClient),
}));
vi.mock('@farvisionllc/sp-client', () => ({
  SpApiClient: vi.fn(() => ({})),
}));

const { handler } = await import('./main.js');

const adsJob = {
  jobId: 'job-1',
  userId: 'auth0|u',
  chatId: 'chat-1',
  sellerId: 'A1SELLER',
  kind: 'ads-performance' as const,
  request: { profileId: 'p1', level: 'campaign', startDate: '', endDate: '' },
  status: 'queued' as const,
};

const fbaJob = {
  ...adsJob,
  kind: 'fba-report' as const,
  request: {
    reportKind: 'ledger-detail',
    from: '2026-08-01',
    to: '2026-08-07',
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('request step', () => {
  it('stores the Amazon report id before anything can poll', async () => {
    jobs.getReportJob.mockResolvedValue(adsJob);
    adsClient.requestPerformanceReport.mockResolvedValue({ reportId: 'R-9' });

    const result = await handler({ step: 'request', jobId: 'job-1' });

    expect(jobs.markJobBuilding).toHaveBeenCalledWith('job-1', 'R-9');
    expect(result).toMatchObject({ state: 'requested' });
  });

  it('finishes immediately for a kind Amazon has already published', async () => {
    jobs.getReportJob.mockResolvedValue(fbaJob);
    jobs.requestFbaReport.mockResolvedValue({
      state: 'ready',
      outcome: { rowsNew: 12, rowsDuplicate: 3, rowsRefreshed: 0 },
    });

    const result = await handler({ step: 'request', jobId: 'job-1' });

    expect(result).toMatchObject({ state: 'ready' });
    // Auto-generated kinds have nothing to wait for, so no id is recorded.
    expect(jobs.markJobBuilding).not.toHaveBeenCalled();
    expect(jobs.completeReportJob).toHaveBeenCalledWith(
      'job-1',
      '12 new rows, 3 already held.'
    );
  });
});

describe('collect step', () => {
  it('returns pending rather than failing while Amazon builds', async () => {
    jobs.getReportJob.mockResolvedValue({
      ...fbaJob,
      amazonReportId: 'R-9',
    });
    jobs.collectFbaReport.mockResolvedValue({
      state: 'pending',
      status: 'IN_PROGRESS',
    });

    const result = await handler({ step: 'collect', jobId: 'job-1' });

    expect(result).toMatchObject({ state: 'pending', status: 'IN_PROGRESS' });
    // Nothing is written: the job is exactly as it was, and the machine Waits.
    expect(jobs.completeReportJob).not.toHaveBeenCalled();
    expect(jobs.failReportJob).not.toHaveBeenCalled();
  });

  it('stores the ads rows while it holds them', async () => {
    jobs.getReportJob.mockResolvedValue({ ...adsJob, amazonReportId: 'R-9' });
    adsClient.fetchPerformanceReport.mockResolvedValue({
      ready: true,
      rows: [{ spend: 1 }],
      attribution: '14d',
    });

    const result = await handler({ step: 'collect', jobId: 'job-1' });

    expect(result).toMatchObject({ state: 'ready' });
    // Leaving them at Amazon made every later answer depend on a retention
    // window we do not control; a campaign report is filed like any other.
    expect(jobs.ingestReportBuffer).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'campaign-performance',
        sellerId: 'A1SELLER',
        source: 'api',
      })
    );
    expect(jobs.completeReportJob).toHaveBeenCalledWith(
      'job-1',
      '1240 new rows.'
    );
    // The window must be recorded or the upload overlap guard cannot see it,
    // and a console export of the same days would land on top of these rows.
    expect(jobs.writeAdsRun).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'campaign-performance',
        status: 'ingested',
      })
    );
  });

  it('still reports success when the run record cannot be written', async () => {
    jobs.getReportJob.mockResolvedValue({ ...adsJob, amazonReportId: 'R-9' });
    adsClient.fetchPerformanceReport.mockResolvedValue({
      ready: true,
      rows: [{ spend: 1 }],
      attribution: '14d',
    });
    jobs.writeAdsRun.mockRejectedValueOnce(new Error('couchbase down'));

    const result = await handler({ step: 'collect', jobId: 'job-1' });

    // The rows are already stored. Failing the job over its paperwork would
    // lose a pull the seller has already paid Amazon for.
    expect(result).toMatchObject({ state: 'ready' });
  });

  it('announces a report id for a level with nowhere to file it', async () => {
    jobs.getReportJob.mockResolvedValue({
      ...adsJob,
      amazonReportId: 'R-9',
      request: { ...adsJob.request, level: 'keyword' },
    });
    adsClient.fetchPerformanceReport.mockResolvedValue({
      ready: true,
      rows: [{ spend: 1 }],
      attribution: '14d',
    });

    const result = await handler({ step: 'collect', jobId: 'job-1' });

    expect(result).toMatchObject({ state: 'ready' });
    // No `keyword` kind exists in the registry, so there is nothing to ingest
    // into and the model redeems the id instead.
    expect(jobs.ingestReportBuffer).not.toHaveBeenCalled();
    expect(jobs.completeReportJob).toHaveBeenCalledWith(
      'job-1',
      'Ads performance report is ready.'
    );
  });

  it('records an ingest refusal rather than claiming success', async () => {
    jobs.getReportJob.mockResolvedValue({ ...adsJob, amazonReportId: 'R-9' });
    adsClient.fetchPerformanceReport.mockResolvedValue({
      ready: true,
      rows: [{ spend: 1 }],
      attribution: '14d',
    });
    jobs.ingestReportBuffer.mockResolvedValueOnce({
      error: 'no data rows',
    } as never);

    const result = await handler({ step: 'collect', jobId: 'job-1' });

    expect(result).toMatchObject({ state: 'failed', error: 'no data rows' });
    expect(jobs.completeReportJob).not.toHaveBeenCalled();
  });

  it('records a job whose report id was lost instead of re-requesting', async () => {
    jobs.getReportJob.mockResolvedValue({
      ...fbaJob,
      amazonReportId: undefined,
    });

    const result = await handler({ step: 'collect', jobId: 'job-1' });

    expect(result).toMatchObject({ state: 'failed' });
    expect(jobs.failReportJob).toHaveBeenCalledWith(
      'job-1',
      expect.stringContaining('Lost track')
    );
    // Requesting a replacement would bill the seller for a report that exists.
    expect(jobs.requestFbaReport).not.toHaveBeenCalled();
  });
});

describe('when a step goes wrong', () => {
  it('writes the failure to the job so the chat can say what happened', async () => {
    jobs.getReportJob.mockResolvedValue({ ...adsJob, amazonReportId: 'R-9' });
    adsClient.fetchPerformanceReport.mockRejectedValue(
      new Error('Amazon returned 500')
    );

    const result = await handler({ step: 'collect', jobId: 'job-1' });

    // Without this the conversation shows "still building" indefinitely.
    expect(jobs.failReportJob).toHaveBeenCalledWith(
      'job-1',
      'Amazon returned 500'
    );
    expect(result).toMatchObject({
      state: 'failed',
      error: 'Amazon returned 500',
    });
  });

  it('gives up quietly on a job that no longer exists', async () => {
    jobs.getReportJob.mockResolvedValue(null);

    const result = await handler({ step: 'request', jobId: 'gone' });

    // Returned, not thrown: a retry policy cannot bring back an expired job,
    // and five attempts proving that is five invocations nobody is waiting on.
    expect(result).toMatchObject({ state: 'failed', error: 'Job not found.' });
    expect(jobs.failReportJob).not.toHaveBeenCalled();
  });
});
