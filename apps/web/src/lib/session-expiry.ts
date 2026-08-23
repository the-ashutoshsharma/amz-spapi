'use client';

/**
 * Noticing that the login session ended, from the browser.
 *
 * The signed-in app is a long-lived SPA. After the first render nothing re-runs
 * the dashboard layout's session check — client-side navigation reuses the
 * layout that is already mounted — so when the Auth0 cookie expires (one day
 * idle, three days absolute, per the library defaults we do not override) the
 * page carries on looking signed in and every request quietly comes back 401.
 *
 * Chat showed it worst. The AI SDK turns a non-OK response into
 * `new Error(await response.text())`, so the answer to a question somebody had
 * just spent a minute typing was the literal string `{"error":"Unauthorized"}`
 * in a red bar, with the message lost and no mention of signing in.
 *
 * This module is the one place those 401s become a state the UI can react to.
 * It is deliberately framework-free — a module-level store plus a `fetch`
 * wrapper — so it is testable without a DOM, and so a component that wants the
 * state does not have to sit under a provider.
 */

import { safeReturnTo } from './signed-out';

type Listener = () => void;

const listeners = new Set<Listener>();
let expired = false;

/** Auth0's own cookie-only route: no database, no upstream call, just a read. */
const PROFILE_ROUTE = '/auth/profile';

/** Marks a `fetch` we already wrapped, so a remount cannot nest wrappers. */
const WRAPPED = Symbol.for('sellavant.session-expiry.fetch');

type WrappedFetch = typeof fetch & { [WRAPPED]?: true };

/**
 * The scope whose `fetch` is watched — `window` in the app, a plain object in
 * a test. Narrow on purpose: nothing here needs the rest of the DOM.
 */
export type FetchScope = {
  fetch: typeof fetch;
  location: { origin: string };
};

export function sessionExpired(): boolean {
  return expired;
}

/**
 * Latch the expired state and tell everyone once.
 *
 * One-way and idempotent: the session cannot come back without a round trip
 * through Auth0, which is a full page load, which resets this module anyway.
 * That also means a burst of parallel 401s — the dashboard fires several
 * requests per page — raises one dialog rather than one per request.
 */
export function markSessionExpired(): void {
  if (expired) return;
  expired = true;
  for (const listener of Array.from(listeners)) listener();
}

export function subscribeToSessionExpiry(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: the store is module state and outlives a single test. */
export function resetSessionExpiryForTests(): void {
  expired = false;
  listeners.clear();
}

/**
 * True when the response is THIS app saying the caller is not signed in.
 *
 * Same-origin only. A 401 from a presigned S3 URL or a partner console says
 * something about that service, and signing back into Sellavant would not fix
 * it — a dialog there would be a lie that costs the user their unsent work.
 *
 * 401 and never 403: the invite gate answers 403 to somebody who IS signed in
 * but has not finished onboarding, and sending them to the login page would
 * bounce them straight back to the same 403.
 */
export function isSignedOutResponse(
  requestUrl: string,
  response: { status: number; url?: string },
  origin: string
): boolean {
  if (response.status !== 401) return false;
  try {
    // `response.url` is the URL after redirects and is absolute; the request
    // URL is the fallback for the responses that do not carry one.
    return new URL(response.url || requestUrl, origin).origin === origin;
  } catch {
    return false;
  }
}

function requestUrlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Wrap `scope.fetch` so any same-origin 401 latches the expired state.
 *
 * A wrapper rather than an `apiFetch` helper every caller must remember: there
 * are forty-odd API routes and the client code that calls them is full of
 * `if (!res.ok) return;` and `catch {}` — best-effort handling that is right
 * for a failed sidebar refresh and is exactly what made the sign-out invisible.
 * Wrapping catches the ones already written and the ones written next year.
 *
 * Returns the uninstall, which matters: leaving the wrapper behind after the
 * signed-in area unmounts would make a marketing page's anonymous
 * `/auth/profile` 401 look like an expiry.
 */
export function watchFetchForSignOut(scope: FetchScope): () => void {
  const original = scope.fetch as WrappedFetch;
  if (original[WRAPPED]) return () => undefined;

  const wrapped: WrappedFetch = async (input, init) => {
    // `.call(scope)` because a detached `window.fetch` is an illegal
    // invocation in every browser engine.
    const response = await original.call(scope, input, init);
    if (
      isSignedOutResponse(requestUrlOf(input), response, scope.location.origin)
    ) {
      markSessionExpired();
    }
    return response;
  };
  wrapped[WRAPPED] = true;
  scope.fetch = wrapped;

  return () => {
    if (scope.fetch === wrapped) scope.fetch = original;
  };
}

/**
 * Ask the server whether the session is still there.
 *
 * For the case the 401 watcher cannot cover: a tab parked overnight, where the
 * session dies with nothing in flight to notice it. Called when the tab comes
 * back, not on a timer — every request through the middleware ROLLS the
 * session, so a background poll would keep a forgotten tab signed in for the
 * full three-day absolute window and quietly defeat the idle timeout it is
 * meant to observe. Somebody returning to the tab is real activity; a timer is
 * not.
 *
 * A network failure says nothing about the session — offline is not signed out
 * — so it is swallowed.
 */
export async function probeSession(scope: FetchScope): Promise<void> {
  let response: Response;
  try {
    response = await scope.fetch.call(scope, PROFILE_ROUTE, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  } catch {
    return;
  }
  // 401 by default; 204 when the route is configured to answer no-content.
  if (response.status === 401 || response.status === 204) {
    markSessionExpired();
  }
}

/**
 * Where to send somebody whose session ended: Auth0, and then back here.
 *
 * `returnTo` is what makes this a resumption rather than a restart — the
 * hardcoded `/chat` everywhere else is right for a first sign-in and wrong for
 * somebody who was three clicks into a shipment.
 */
export function signInUrl(location: {
  pathname: string;
  search: string;
}): string {
  const here = safeReturnTo(`${location.pathname}${location.search}`);
  return `/auth/login?returnTo=${encodeURIComponent(here)}`;
}
