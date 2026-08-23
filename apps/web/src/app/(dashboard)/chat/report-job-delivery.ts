/**
 * The decisions behind report-job polling, separated from the effect that runs
 * them.
 *
 * Both are small and both are the part that can be wrong in a way nobody
 * notices: a loop that stops early leaves a finished report undelivered, and a
 * merge that does not dedupe posts the same message twice. Kept free of React
 * so they can be tested the way the rest of this directory is — as functions,
 * without a DOM.
 */

export type JobsResponse = {
  delivered?: Array<{ jobId: string; text: string }>;
  pending?: Array<{ jobId: string; status: string }>;
};

export type PollDecision = {
  deliver: Array<{ jobId: string; text: string }>;
  keepPolling: boolean;
};

/**
 * What to do with one poll result.
 *
 * `body === null` means the request itself failed — offline, a blip, a 500.
 * That is NOT "nothing is pending": the job is still building either way, so a
 * failed check keeps the loop alive. Treating it as empty would abandon a
 * report because the network hiccuped once.
 */
export function pollDecision(body: JobsResponse | null): PollDecision {
  if (body === null) return { deliver: [], keepPolling: true };
  return {
    deliver: body.delivered ?? [],
    keepPolling: (body.pending?.length ?? 0) > 0,
  };
}

/**
 * Append delivered messages that are not already on screen.
 *
 * Message ids are derived from the job id, so the same delivery arriving twice
 * — two tabs, a reconnect, a re-render — is recognisable. Returns the original
 * array when nothing is new, so React can skip the re-render.
 */
export function mergeDelivered<T extends { id: string }>(
  current: T[],
  incoming: T[]
): T[] {
  const held = new Set(current.map((message) => message.id));
  const fresh = incoming.filter((message) => !held.has(message.id));
  return fresh.length ? [...current, ...fresh] : current;
}

/** The assistant message a delivered job becomes. */
export function deliveredMessage(job: { jobId: string; text: string }): {
  id: string;
  role: 'assistant';
  parts: Array<{ type: 'text'; text: string }>;
} {
  return {
    id: `report-${job.jobId}`,
    role: 'assistant',
    parts: [{ type: 'text', text: job.text }],
  };
}
