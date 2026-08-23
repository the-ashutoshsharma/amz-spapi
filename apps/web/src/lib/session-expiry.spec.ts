import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isSignedOutResponse,
  markSessionExpired,
  probeSession,
  resetSessionExpiryForTests,
  sessionExpired,
  signInUrl,
  subscribeToSessionExpiry,
  watchFetchForSignOut,
  type FetchScope,
} from './session-expiry';

/**
 * Noticing a dead login session.
 *
 * Every failure here is silent by construction: the page still renders, the
 * buttons still click, and the only evidence is a 401 nobody looks at. The two
 * that matter are opposite mistakes — missing a real sign-out, which is the bug
 * this exists for, and claiming one on a 401 that has nothing to do with our
 * session, which would throw away a seller's unsent work for no reason.
 */

const ORIGIN = 'https://app.sellavant.com';

function scopeWith(fetchImpl: FetchScope['fetch']): FetchScope {
  return { fetch: fetchImpl, location: { origin: ORIGIN } };
}

function responseWith(status: number, url = ''): Response {
  return { status, url } as Response;
}

beforeEach(() => {
  resetSessionExpiryForTests();
});

describe('isSignedOutResponse', () => {
  it('recognises a 401 from our own API', () => {
    expect(isSignedOutResponse('/api/chat', responseWith(401), ORIGIN)).toBe(
      true
    );
  });

  it('ignores a 401 from somewhere else', () => {
    // A presigned S3 URL going stale is not a reason to sign anybody out.
    expect(
      isSignedOutResponse(
        'https://s3.amazonaws.com/bucket/key',
        responseWith(401),
        ORIGIN
      )
    ).toBe(false);
  });

  it('ignores 403, which the invite gate uses for onboarding', () => {
    // Sending that user to the login page would bounce them back to the same
    // 403, forever.
    expect(isSignedOutResponse('/api/chat', responseWith(403), ORIGIN)).toBe(
      false
    );
  });

  it('judges by where the response came from, not where it was aimed', () => {
    expect(
      isSignedOutResponse(
        '/api/chat',
        responseWith(401, 'https://elsewhere.example/api/chat'),
        ORIGIN
      )
    ).toBe(false);
  });
});

describe('watchFetchForSignOut', () => {
  it('marks the session expired on a same-origin 401', async () => {
    const scope = scopeWith(async () => responseWith(401));
    watchFetchForSignOut(scope);

    await scope.fetch('/api/chats');

    expect(sessionExpired()).toBe(true);
  });

  it('leaves a successful response alone', async () => {
    const scope = scopeWith(async () => responseWith(200));
    watchFetchForSignOut(scope);

    await scope.fetch('/api/chats');

    expect(sessionExpired()).toBe(false);
  });

  it('returns the response untouched', async () => {
    const body = responseWith(401);
    const scope = scopeWith(async () => body);
    watchFetchForSignOut(scope);

    expect(await scope.fetch('/api/chats')).toBe(body);
  });

  it('accepts a Request as well as a string', async () => {
    const scope = scopeWith(async () => responseWith(401));
    watchFetchForSignOut(scope);

    await scope.fetch(new Request(`${ORIGIN}/api/chats`));

    expect(sessionExpired()).toBe(true);
  });

  it('uninstalls, so a marketing page does not inherit the watch', async () => {
    const original = vi.fn(async () => responseWith(401));
    const scope = scopeWith(original);

    const stop = watchFetchForSignOut(scope);
    stop();
    await scope.fetch('/auth/profile');

    expect(scope.fetch).toBe(original);
    expect(sessionExpired()).toBe(false);
  });

  it('does not nest wrappers when installed twice', async () => {
    const scope = scopeWith(async () => responseWith(200));
    const stop = watchFetchForSignOut(scope);
    const wrapped = scope.fetch;

    watchFetchForSignOut(scope);
    expect(scope.fetch).toBe(wrapped);

    // The first uninstall is still the one that restores the original.
    stop();
    expect(scope.fetch).not.toBe(wrapped);
  });
});

describe('markSessionExpired', () => {
  it('tells every listener, once, however many 401s arrive', () => {
    // A dashboard page fires several requests at a time; one dialog, not five.
    const listener = vi.fn();
    subscribeToSessionExpiry(listener);

    markSessionExpired();
    markSessionExpired();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(sessionExpired()).toBe(true);
  });

  it('stops telling a listener that unsubscribed', () => {
    const listener = vi.fn();
    subscribeToSessionExpiry(listener)();

    markSessionExpired();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('probeSession', () => {
  it('marks the session expired when the profile route says 401', async () => {
    await probeSession(scopeWith(async () => responseWith(401)));

    expect(sessionExpired()).toBe(true);
  });

  it('accepts the no-content form of the same answer', async () => {
    await probeSession(scopeWith(async () => responseWith(204)));

    expect(sessionExpired()).toBe(true);
  });

  it('says nothing when the profile comes back', async () => {
    await probeSession(scopeWith(async () => responseWith(200)));

    expect(sessionExpired()).toBe(false);
  });

  it('treats a network failure as offline, not as signed out', async () => {
    // Someone on a train has not been signed out, and telling them they have
    // would discard the message they are in the middle of writing.
    await probeSession(
      scopeWith(async () => {
        throw new TypeError('Failed to fetch');
      })
    );

    expect(sessionExpired()).toBe(false);
  });
});

describe('signInUrl', () => {
  it('comes back to the page the seller was on, query and all', () => {
    expect(signInUrl({ pathname: '/shipments', search: '?id=SHP-1' })).toBe(
      `/auth/login?returnTo=${encodeURIComponent('/shipments?id=SHP-1')}`
    );
  });

  it('refuses a protocol-relative path', () => {
    expect(signInUrl({ pathname: '//evil.example', search: '' })).toBe(
      `/auth/login?returnTo=${encodeURIComponent('/chat')}`
    );
  });
});
