import crypto from 'node:crypto';
import {
  executeQuery,
  getDocument,
  insertDocument,
  upsertDocument,
  collectionName,
} from '@amz-spapi/couchbase-utils';

/**
 * Durable record of a report the user asked for in chat.
 *
 * ## Why this exists
 *
 * Amazon builds reports asynchronously over minutes. Both report paths in the
 * chat handled that by making the USER the scheduler:
 *
 *   - `request-ad-report` returned a reportId and instructed the model to end
 *     its turn, so the result arrived only when the user thought to ask again.
 *   - `sync-report` blocked in-turn for `REPORT_TIMEOUT_MS.requestSafe` and
 *     then threw, advising the model to "reuse this id" — through a tool
 *     surface that had nowhere to put a report id. The work was discarded and
 *     the next attempt made Amazon rebuild the same report.
 *
 * A chat turn is the wrong place to hold a multi-minute wait, and a tool result
 * is the wrong place to keep the only copy of a report id. This collection is
 * the copy that outlives the turn: once `amazonReportId` is stored, a report
 * that is still building can always be collected rather than re-requested.
 *
 * ## Why delivery is claimed rather than flagged
 *
 * A finished job has to become a message in the chat exactly once. Retries are
 * expected — Step Functions retries a failed Lambda, and a reconnecting browser
 * re-reads pending jobs — so "check `deliveredAt`, then set it" would race two
 * deliverers into two identical messages. `claimDelivery` uses an INSERT of a
 * separate claim document, which the first caller wins and every later one
 * loses, because insert-if-absent is the only atomic primitive the Data API
 * offers. See ADR-0010 for why that is the transport.
 */

const SCOPE = 'ops';
const COLLECTION = 'report_jobs';
const SCHEMA_VERSION = 1;

/**
 * Long enough to survive a weekend of nobody looking, short enough that these
 * never become a table anyone has to prune. The rows a job produced live in the
 * report store with their own retention; this is only the request's paperwork.
 */
const JOB_TTL_SECONDS = 30 * 24 * 60 * 60;

export type ReportJobKind = 'ads-performance' | 'fba-report';

export type ReportJobStatus =
  /** Accepted from the chat, not yet handed to Amazon. */
  | 'queued'
  /** Amazon accepted the request; `amazonReportId` is set from here on. */
  | 'building'
  /** Rows are ingested and the summary is ready to show. */
  | 'ready'
  | 'failed';

export type ReportJob = {
  schemaVersion: number;
  jobId: string;
  userId: string;
  /** Where the answer goes. A job with no chat has no one to tell. */
  chatId: string;
  /**
   * Required, not optional. Every step of this reaches Amazon on a seller's
   * behalf and files rows under them; a job without one cannot be run at all,
   * so it must not be possible to create.
   */
  sellerId: string;
  kind: ReportJobKind;
  /**
   * The tool input, kept verbatim so the worker can act on it without the
   * caller having to flatten every report kind into one shape.
   */
  request: Record<string, unknown>;
  status: ReportJobStatus;
  /**
   * Amazon's report id, stored the moment Amazon accepts the request.
   *
   * The single most important field here. Losing it is what turned a slow
   * report into a rebuilt one.
   */
  amazonReportId?: string;
  /** One line for the chat: what landed, and how much of it. */
  summary?: string;
  /** Why it failed, in the words the user should see. */
  error?: string;
  createdAt: number;
  updatedAt: number;
  /** Set by `claimDelivery`, never written directly. */
  deliveredAt?: number;
};

/**
 * Storage seam, matching `cost-ledger`'s. These four calls are the only I/O in
 * this module, so the state machine below is testable without a cluster.
 */
export const reportJobStorage = {
  getDocument,
  upsertDocument,
  insertDocument,
  executeQuery,
};

const jobKey = (jobId: string): string => `job::${jobId}`;
const claimKey = (jobId: string): string => `claim::${jobId}`;

/** Opaque, unguessable, and short enough to read back to a user. */
export function newJobId(): string {
  return crypto.randomBytes(12).toString('hex');
}

export async function createReportJob(params: {
  userId: string;
  chatId: string;
  sellerId: string;
  kind: ReportJobKind;
  request: Record<string, unknown>;
  now?: number;
}): Promise<ReportJob> {
  const now = params.now ?? Date.now();
  const job: ReportJob = {
    schemaVersion: SCHEMA_VERSION,
    jobId: newJobId(),
    userId: params.userId,
    chatId: params.chatId,
    sellerId: params.sellerId,
    kind: params.kind,
    request: params.request,
    status: 'queued',
    createdAt: now,
    updatedAt: now,
  };
  await reportJobStorage.upsertDocument(
    SCOPE,
    COLLECTION,
    jobKey(job.jobId),
    job,
    JOB_TTL_SECONDS
  );
  return job;
}

export async function getReportJob(jobId: string): Promise<ReportJob | null> {
  return reportJobStorage.getDocument<ReportJob>(
    SCOPE,
    COLLECTION,
    jobKey(jobId)
  );
}

/**
 * Merge a patch onto a stored job.
 *
 * Read-modify-write rather than a targeted mutation because the Data API has no
 * sub-document update, and because every writer here is a single step of one
 * state machine — the concurrent writers this would lose to do not exist. The
 * one genuinely contended transition, delivery, is not done this way.
 */
async function patchJob(
  jobId: string,
  patch: Partial<ReportJob>,
  now = Date.now()
): Promise<ReportJob | null> {
  const existing = await getReportJob(jobId);
  if (!existing) return null;
  const updated: ReportJob = { ...existing, ...patch, updatedAt: now };
  await reportJobStorage.upsertDocument(
    SCOPE,
    COLLECTION,
    jobKey(jobId),
    updated,
    JOB_TTL_SECONDS
  );
  return updated;
}

/**
 * Record that Amazon accepted the request and is building the report.
 *
 * Called before the first poll, deliberately: a crash between "Amazon started
 * building" and "we wrote down the id" is exactly the window that used to cost
 * a duplicate report.
 */
export function markJobBuilding(
  jobId: string,
  amazonReportId: string,
  now?: number
): Promise<ReportJob | null> {
  return patchJob(jobId, { status: 'building', amazonReportId }, now);
}

export function completeReportJob(
  jobId: string,
  summary: string,
  now?: number
): Promise<ReportJob | null> {
  return patchJob(jobId, { status: 'ready', summary }, now);
}

export function failReportJob(
  jobId: string,
  error: string,
  now?: number
): Promise<ReportJob | null> {
  return patchJob(jobId, { status: 'failed', error }, now);
}

/**
 * Win the right to deliver this job's result into the chat.
 *
 * Returns true exactly once per job, for the caller that got there first.
 * Everyone else — a Step Functions retry, a second browser tab, a reconnect
 * that re-read the same pending job — gets false and must not post anything.
 */
export async function claimDelivery(
  jobId: string,
  userId: string,
  now = Date.now()
): Promise<boolean> {
  const won = await reportJobStorage.insertDocument(
    SCOPE,
    COLLECTION,
    claimKey(jobId),
    { jobId, userId, claimedAt: now },
    JOB_TTL_SECONDS
  );
  if (!won) return false;
  // Best-effort breadcrumb on the job itself. The claim document is the
  // authority; this only makes a stored job readable without joining to it.
  await patchJob(jobId, { deliveredAt: now }, now).catch(() => null);
  return true;
}

/**
 * Jobs for one chat that are still owed an answer.
 *
 * Drives two things: what a reconnecting browser subscribes to, and what the
 * agent can truthfully say is in flight. Ordered oldest first so a chat that
 * queued several reports resolves them in the order they were asked for.
 */
export async function pendingJobsForChat(params: {
  userId: string;
  chatId: string;
  limit?: number;
}): Promise<ReportJob[]> {
  const { rows } = await reportJobStorage.executeQuery<ReportJob>(
    SCOPE,
    `SELECT job.*
       FROM \`${collectionName(SCOPE, COLLECTION)}\` AS job
      WHERE job.userId = $userId
        AND job.chatId = $chatId
        AND job.jobId IS NOT MISSING
        AND job.deliveredAt IS MISSING
      ORDER BY job.createdAt ASC
      LIMIT $limit`,
    {
      parameters: {
        userId: params.userId,
        chatId: params.chatId,
        limit: params.limit ?? 20,
      },
      readonly: true,
    }
  );
  return rows;
}

/**
 * Jobs that finished since the browser last heard, for the SSE channel.
 *
 * `deliveredAt IS MISSING` rather than a timestamp cursor: a job is owed to the
 * chat until someone has actually posted it, and that is a fact about the job
 * rather than about when a particular socket connected. A tab that was closed
 * for an hour gets the same answer as one that never disconnected.
 */
export async function undeliveredFinishedJobs(params: {
  userId: string;
  chatId: string;
}): Promise<ReportJob[]> {
  const pending = await pendingJobsForChat(params);
  return pending.filter(
    (job) => job.status === 'ready' || job.status === 'failed'
  );
}
