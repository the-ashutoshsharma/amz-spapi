import { after } from 'next/server';
import {
  claimDelivery,
  pendingJobsForChat,
  type ReportJob,
} from '@amz-spapi/sp-cache';
import { auth0 } from '../../../../../lib/auth0';
import { isValidChatId, saveChatTurn } from '../../../../../lib/chat-store';
import { loggerFor } from '../../../../../lib/logger';
import { flushLogs } from '../../../../../lib/otel-logs';

const log = loggerFor('report-jobs');

/**
 * What this conversation is still owed, and anything that has just landed.
 *
 * The chat polls this while a report is in flight. Polling rather than SSE, and
 * deliberately: a Vercel route is capped at 300 seconds, so an SSE connection
 * would die and reconnect on a timer anyway while being billed for the whole
 * wait — all to deliver an event that is minutes rather than milliseconds away.
 * The client stops asking entirely when nothing is pending, so the idle cost is
 * zero. If this ever needs to be instant, a Pusher-style channel replaces the
 * transport without touching the job store underneath.
 *
 * ## Why the message is written here and not by the worker
 *
 * `chat-store` owns message sequencing, and it lives in this app. A Lambda
 * appending to a conversation would be a second writer to state with one owner
 * — and the seq accounting in `saveChatTurn` is exactly the kind of thing that
 * breaks quietly when two processes both believe they are authoritative.
 */

export const maxDuration = 15;

/** The assistant line a finished job becomes. */
function messageFor(job: ReportJob): string {
  if (job.status === 'failed') {
    return `The ${label(job)} could not be built: ${
      job.error ?? 'Amazon did not say why.'
    }`;
  }
  /**
   * Row counts when the rows were stored, a report id when they were not.
   *
   * Ads reports at campaign and search-term level are now ingested at collect
   * time, so the answer is in the report store and the model can total it like
   * any other report. `keyword` level has no kind to be filed under, so it
   * still hands over an id for `get-ad-report` to redeem.
   */
  if (job.summary) return `The ${label(job)} finished: ${job.summary}`;
  return (
    `The ${label(job)} you asked for is ready` +
    (job.amazonReportId ? ` (report ${job.amazonReportId}).` : '.')
  );
}

const label = (job: ReportJob): string =>
  job.kind === 'ads-performance'
    ? 'ads performance report'
    : `${String(job.request['reportKind'] ?? 'FBA')} report`;

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ chatId: string }> }
) {
  after(() => flushLogs());

  const session = await auth0.getSession();
  if (!session?.user) {
    return Response.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const { chatId } = await params;
  if (!isValidChatId(chatId)) {
    return Response.json({ error: 'Invalid chat id' }, { status: 400 });
  }

  const userId = session.user.sub as string;
  // Scoped by userId as well as chatId, so a guessed chat id returns nothing
  // rather than somebody else's report.
  const pending = await pendingJobsForChat({ userId, chatId });

  const delivered: Array<{ jobId: string; text: string }> = [];
  for (const job of pending) {
    if (job.status !== 'ready' && job.status !== 'failed') continue;

    // Exactly one caller may post this. A second tab polling the same chat, or
    // this request being retried, must not produce a duplicate message.
    if (!(await claimDelivery(job.jobId, userId))) continue;

    const text = messageFor(job);
    try {
      await saveChatTurn({
        userId,
        chatId,
        messages: [
          {
            id: `report-${job.jobId}`,
            role: 'assistant',
            parts: [{ type: 'text', text }],
          },
        ],
      });
      delivered.push({ jobId: job.jobId, text });
    } catch (error) {
      /**
       * The claim is already spent, so this message will never be written by
       * anyone. Logged loudly rather than swallowed: the alternative is a job
       * that reads as delivered in the store and never appeared in the chat.
       */
      log.error(
        {
          jobId: job.jobId,
          error: error instanceof Error ? error.message : error,
        },
        'claimed a report job but could not write its message'
      );
    }
  }

  const stillWaiting = pending.filter(
    (job) => job.status === 'queued' || job.status === 'building'
  );

  return Response.json({
    delivered,
    // The client keeps polling while this is non-empty and stops when it is
    // not, which is what makes the idle cost of this endpoint nothing at all.
    pending: stillWaiting.map((job) => ({
      jobId: job.jobId,
      kind: job.kind,
      status: job.status,
    })),
  });
}
