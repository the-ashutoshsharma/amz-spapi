import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Turning a finished report job into a message in the conversation.
 *
 * This route is the only place a background report becomes visible to a person,
 * which makes two failures worth pinning:
 *
 * ## A message must land exactly once
 *
 * Two tabs polling the same chat, or one request retried, both arrive here with
 * the same finished job. `claimDelivery` decides which one may post — so the
 * order matters: claim FIRST, write second. Reversing it posts twice and then
 * argues about who owns the claim.
 *
 * ## A claim spent on a message that never got written is a lost report
 *
 * If `saveChatTurn` throws after the claim is taken, nobody else can ever
 * deliver that job — the claim is gone and `deliveredAt` is set. The route must
 * not swallow that: it looks identical, from the store, to a report that was
 * delivered successfully, and the seller simply never sees it.
 */

const getSession = vi.fn();
const pendingJobsForChat = vi.fn();
const claimDelivery = vi.fn();
const saveChatTurn = vi.fn();
const logError = vi.fn();

vi.mock('@amz-spapi/sp-cache', () => ({
  pendingJobsForChat: (...args: unknown[]) => pendingJobsForChat(...args),
  claimDelivery: (...args: unknown[]) => claimDelivery(...args),
}));

vi.mock('../../../../../lib/auth0', () => ({
  auth0: { getSession: (...args: unknown[]) => getSession(...args) },
}));

vi.mock('../../../../../lib/chat-store', () => ({
  isValidChatId: (value: unknown) =>
    typeof value === 'string' && value.startsWith('chat_'),
  saveChatTurn: (...args: unknown[]) => saveChatTurn(...args),
}));

vi.mock('../../../../../lib/logger', () => ({
  loggerFor: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => logError(...args),
    debug: vi.fn(),
  }),
}));

vi.mock('../../../../../lib/otel-logs', () => ({ flushLogs: vi.fn() }));

vi.mock('next/server', () => ({ after: (fn: () => void) => fn() }));

const { GET } = await import('./route');

const USER = 'auth0|seller';
const CHAT = 'chat_abcdefgh';

const call = (chatId = CHAT) =>
  GET(new Request(`https://sellavant.com/api/chat/${chatId}/jobs`), {
    params: Promise.resolve({ chatId }),
  });

const readyJob = (over: Record<string, unknown> = {}) => ({
  jobId: 'job-1',
  userId: USER,
  chatId: CHAT,
  kind: 'fba-report',
  request: { reportKind: 'ledger-detail' },
  status: 'ready',
  summary: '412 new rows.',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue({ user: { sub: USER } });
  pendingJobsForChat.mockResolvedValue([]);
  claimDelivery.mockResolvedValue(true);
  saveChatTurn.mockResolvedValue(undefined);
});

describe('who may read a chat', () => {
  it('refuses an unauthenticated caller', async () => {
    getSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(pendingJobsForChat).not.toHaveBeenCalled();
  });

  it('scopes the lookup to the caller, not just the chat id', async () => {
    await call();
    // A guessed chat id must return nothing rather than someone else's report.
    expect(pendingJobsForChat).toHaveBeenCalledWith({
      userId: USER,
      chatId: CHAT,
    });
  });

  it('rejects a malformed chat id before touching the store', async () => {
    expect((await call('../etc/passwd')).status).toBe(400);
    expect(pendingJobsForChat).not.toHaveBeenCalled();
  });
});

describe('delivering a finished job', () => {
  it('claims before it writes', async () => {
    const order: string[] = [];
    claimDelivery.mockImplementation(async () => {
      order.push('claim');
      return true;
    });
    saveChatTurn.mockImplementation(async () => {
      order.push('write');
    });
    pendingJobsForChat.mockResolvedValue([readyJob()]);

    await call();

    // Writing first would post the message, then discover someone else owned
    // the right to post it.
    expect(order).toEqual(['claim', 'write']);
  });

  it('posts nothing when another poller already claimed the job', async () => {
    claimDelivery.mockResolvedValue(false);
    pendingJobsForChat.mockResolvedValue([readyJob()]);

    const body = await (await call()).json();

    expect(saveChatTurn).not.toHaveBeenCalled();
    expect(body.delivered).toEqual([]);
  });

  it('writes the row counts for a finished report', async () => {
    pendingJobsForChat.mockResolvedValue([readyJob()]);

    const body = await (await call()).json();

    expect(body.delivered[0].text).toContain('412 new rows.');
    const [written] = saveChatTurn.mock.calls[0] as [
      { messages: Array<{ id: string; role: string }> }
    ];
    // Id derived from the job, so a duplicate delivery is recognisable rather
    // than becoming a second message.
    expect(written.messages[0]).toMatchObject({
      id: 'report-job-1',
      role: 'assistant',
    });
  });

  it('reports row counts for an ads report whose rows were stored', async () => {
    pendingJobsForChat.mockResolvedValue([
      readyJob({
        kind: 'ads-performance',
        amazonReportId: 'R-9',
        summary: '1240 new rows.',
        request: {},
      }),
    ]);

    const body = await (await call()).json();

    // Rows are ingested at collect time, so the answer is already held and the
    // report id is no longer the thing the model needs.
    expect(body.delivered[0].text).toContain('1240 new rows.');
  });

  it('falls back to the report id when the rows could not be stored', async () => {
    pendingJobsForChat.mockResolvedValue([
      readyJob({
        kind: 'ads-performance',
        amazonReportId: 'R-9',
        summary: undefined,
        request: { level: 'keyword' },
      }),
    ]);

    const body = await (await call()).json();

    // `keyword` level has no report kind to be filed under, so the model still
    // redeems the id with get-ad-report.
    expect(body.delivered[0].text).toContain('R-9');
  });

  it('reports a failure in the seller’s words rather than staying silent', async () => {
    pendingJobsForChat.mockResolvedValue([
      readyJob({
        status: 'failed',
        summary: undefined,
        error: 'Amazon found no data in that date range.',
      }),
    ]);

    const body = await (await call()).json();

    expect(body.delivered[0].text).toContain('no data in that date range');
  });

  it('logs loudly when the claim is spent but the write fails', async () => {
    saveChatTurn.mockRejectedValue(new Error('couchbase unreachable'));
    pendingJobsForChat.mockResolvedValue([readyJob()]);

    const response = await call();
    const body = await response.json();

    // The claim is gone, so no one will ever deliver this job again. From the
    // store it is indistinguishable from a successful delivery — the log is the
    // only trace that a seller is owed a report they never received.
    expect(response.status).toBe(200);
    expect(body.delivered).toEqual([]);
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: 'job-1' }),
      expect.stringContaining('could not write its message')
    );
  });
});

describe('what the client keeps polling for', () => {
  it('reports jobs still running so the browser keeps asking', async () => {
    pendingJobsForChat.mockResolvedValue([
      readyJob({ jobId: 'job-2', status: 'building' }),
    ]);

    const body = await (await call()).json();

    expect(body.pending).toEqual([
      { jobId: 'job-2', kind: 'fba-report', status: 'building' },
    ]);
    expect(claimDelivery).not.toHaveBeenCalled();
  });

  it('reports nothing pending once the last job is delivered, so polling stops', async () => {
    pendingJobsForChat.mockResolvedValue([readyJob()]);

    const body = await (await call()).json();

    // An empty `pending` is what makes the idle cost of this endpoint zero.
    expect(body.pending).toEqual([]);
    expect(body.delivered).toHaveLength(1);
  });
});
