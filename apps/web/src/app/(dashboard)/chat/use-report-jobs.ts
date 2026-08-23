'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { AppMessage } from './message-bubble';
import {
  deliveredMessage,
  pollDecision,
  type JobsResponse,
} from './report-job-delivery';

/**
 * Deliver reports that finish after the turn that asked for them.
 *
 * Amazon takes minutes to build a report, and a chat turn cannot hold that
 * long. Rather than telling the user to come back and ask — which is what the
 * agent used to be instructed to do — the conversation checks for itself and
 * drops the answer in when it lands.
 *
 * ## Why polling
 *
 * A Vercel route is capped at 300 seconds, so an SSE connection would be torn
 * down and re-established on a timer regardless, billed for the whole wait, to
 * deliver an event that is minutes rather than milliseconds away. Polling costs
 * nothing when nothing is pending, which is almost always. Swapping in a
 * push channel later changes this file and nothing behind it.
 *
 * ## What stops it running forever
 *
 * Three things, because an interval that outlives its reason is how a chat tab
 * ends up making a request every five seconds for a day:
 *
 *  - it only starts after a turn ends or on mount, never on a timer of its own;
 *  - it stops as soon as the server reports nothing pending;
 *  - it pauses entirely while the tab is hidden, and resumes on return.
 */

const POLL_MS = 5_000;

export function useReportJobs(params: {
  chatId: string | null;
  /** A turn that just ended may have queued something. */
  isStreaming: boolean;
  appendMessages: (messages: AppMessage[]) => void;
  /**
   * Continue the conversation now that something landed.
   *
   * Posting the message is not enough: an assistant message appearing in the
   * list starts no model turn, so the report sat there announced but unread
   * until the user typed something. The agent had already promised to "fetch
   * and present the results", which made the gap read as the agent forgetting.
   */
  onDelivered?: () => void;
}): void {
  const { chatId, isStreaming, appendMessages, onDelivered } = params;

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const stopped = useRef(false);
  // Held in a ref so the poll loop never re-creates itself mid-flight and
  // leaves two intervals racing each other.
  const append = useRef(appendMessages);
  useEffect(() => {
    append.current = appendMessages;
  }, [appendMessages]);
  const delivered = useRef(onDelivered);
  useEffect(() => {
    delivered.current = onDelivered;
  }, [onDelivered]);

  const clear = useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  }, []);

  const check = useCallback(async () => {
    if (!chatId || stopped.current) return;
    if (typeof document !== 'undefined' && document.hidden) {
      // Try again when the tab comes back rather than burning requests behind
      // a window nobody is looking at.
      return;
    }

    let body: JobsResponse | null = null;
    try {
      const response = await fetch(`/api/chat/${chatId}/jobs`);
      body = response.ok ? ((await response.json()) as JobsResponse) : null;
    } catch {
      // Offline or a blip. `pollDecision` treats null as "still unknown" and
      // keeps the loop alive rather than concluding nothing is left to wait for.
      body = null;
    }

    if (stopped.current) return;

    const { deliver, keepPolling } = pollDecision(body);
    if (deliver.length) {
      append.current(deliver.map(deliveredMessage) as AppMessage[]);
      /**
       * Deferred a tick, not called inline.
       *
       * The turn must be requested with the delivered message already in the
       * list — a request that races the append asks the model to continue from
       * "the report is running", which is a question it has nothing new to
       * answer. Yielding once lets the append settle first.
       */
      setTimeout(() => delivered.current?.(), 0);
    }

    clear();
    if (keepPolling) timer.current = setTimeout(check, POLL_MS);
  }, [chatId, clear]);

  // A turn that has just finished streaming is the moment a job may have been
  // queued, so that is when to start looking. Mount covers reports that
  // outlived the last session.
  useEffect(() => {
    if (!chatId || isStreaming) return;
    stopped.current = false;
    void check();
    return () => {
      stopped.current = true;
      clear();
    };
  }, [chatId, isStreaming, check, clear]);

  // Resume immediately on returning to the tab, rather than waiting out a
  // sleep that was scheduled before it was hidden.
  useEffect(() => {
    const onVisible = () => {
      if (!document.hidden) void check();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [check]);
}
