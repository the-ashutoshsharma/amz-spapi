import { describe, expect, it } from 'vitest';
import {
  deliveredMessage,
  mergeDelivered,
  pollDecision,
} from './report-job-delivery';

/**
 * The two decisions behind report-job polling.
 *
 * Both failures are invisible at the time they happen. A loop that stops early
 * leaves a finished report sitting undelivered — indistinguishable, to the
 * person waiting, from a report that is simply slow. A merge that does not
 * dedupe posts the same answer twice, which reads as the agent repeating
 * itself.
 */

describe('deciding whether to keep polling', () => {
  it('keeps polling while the server says work is outstanding', () => {
    expect(
      pollDecision({ pending: [{ jobId: 'j1', status: 'building' }] })
    ).toMatchObject({ keepPolling: true });
  });

  it('stops once nothing is pending, so an idle tab costs nothing', () => {
    expect(pollDecision({ delivered: [], pending: [] })).toEqual({
      deliver: [],
      keepPolling: false,
    });
  });

  it('keeps polling when the request itself failed', () => {
    // null is "we do not know", not "nothing is pending". Treating a network
    // blip as an empty queue abandons a report that is still building.
    expect(pollDecision(null)).toEqual({ deliver: [], keepPolling: true });
  });

  it('delivers and then stops when the last job lands', () => {
    const decision = pollDecision({
      delivered: [{ jobId: 'j1', text: '412 new rows.' }],
      pending: [],
    });

    expect(decision.deliver).toHaveLength(1);
    expect(decision.keepPolling).toBe(false);
  });

  it('delivers and keeps going while another job is still running', () => {
    const decision = pollDecision({
      delivered: [{ jobId: 'j1', text: 'done' }],
      pending: [{ jobId: 'j2', status: 'building' }],
    });

    expect(decision.deliver).toHaveLength(1);
    expect(decision.keepPolling).toBe(true);
  });

  it('treats missing fields as empty rather than throwing', () => {
    expect(pollDecision({})).toEqual({ deliver: [], keepPolling: false });
  });
});

describe('merging delivered messages', () => {
  const a = { id: 'report-j1' };
  const b = { id: 'report-j2' };

  it('appends a message not already on screen', () => {
    expect(mergeDelivered([a], [b])).toEqual([a, b]);
  });

  it('ignores a delivery that is already present', () => {
    // Two tabs, or a reconnect, can both hand over the same job.
    expect(mergeDelivered([a, b], [b])).toEqual([a, b]);
  });

  it('returns the SAME array when nothing is new, so React can skip a render', () => {
    const current = [a, b];
    expect(mergeDelivered(current, [a])).toBe(current);
  });

  it('adds only the unseen half of a mixed batch', () => {
    expect(mergeDelivered([a], [a, b])).toEqual([a, b]);
  });
});

describe('the message a job becomes', () => {
  it('derives its id from the job, which is what makes dedup possible', () => {
    expect(deliveredMessage({ jobId: 'j1', text: 'done' })).toEqual({
      id: 'report-j1',
      role: 'assistant',
      parts: [{ type: 'text', text: 'done' }],
    });
  });

  it('matches the id the server writes, so a reload does not duplicate it', () => {
    // The route stores the message as `report-${job.jobId}`; if these two ever
    // disagreed, a delivered report would appear twice after a refresh.
    expect(deliveredMessage({ jobId: 'abc', text: 'x' }).id).toBe('report-abc');
  });
});

describe('what a delivery has to do besides appear', () => {
  it('reports something to deliver, which is what starts the next turn', () => {
    // The hook calls its onDelivered signal only when this is non-empty. An
    // assistant message appearing in the list starts no model turn on its own,
    // so a report could land, be announced, and never be read.
    const { deliver } = pollDecision({
      delivered: [{ jobId: 'j1', text: 'ready (report abc)' }],
      pending: [],
    });
    expect(deliver).toHaveLength(1);
  });

  it('signals nothing when only unfinished jobs came back', () => {
    // A turn started here would be the model talking to itself about a report
    // that has not arrived.
    const { deliver, keepPolling } = pollDecision({
      delivered: [],
      pending: [{ jobId: 'j2', status: 'building' }],
    });
    expect(deliver).toEqual([]);
    expect(keepPolling).toBe(true);
  });
});
