/**
 * Where a request without a session goes, and how it gets back.
 *
 * Shared by the server gates (a dashboard route rendered for somebody whose
 * cookie has gone) and by the client's expiry dialog, because the rule that
 * matters is the same in both: a `returnTo` is only ever a path on this site.
 * Anything else — an absolute URL, a protocol-relative `//evil.example`, a
 * backslashed `/\evil.example` — is an open redirect wearing a helpful name.
 * The SDK's `toSafeRedirect` catches these too, but only on the paths that go
 * through it: a caller that assigns this result to `location.href` has no such
 * backstop, so this cannot rely on one.
 */

const DEFAULT_RETURN_TO = '/chat';

/**
 * Resolved against a base rather than pattern-matched, because the patterns
 * that leave this origin are not all spellable as a prefix.
 *
 * `/\evil.example` passes `startsWith('/') && !startsWith('//')` and then
 * resolves to `https://evil.example/`, because browsers normalise a backslash
 * to a forward slash in the authority position. Asking the URL parser where a
 * value actually points is the only check that keeps up with that; a list of
 * bad prefixes is a list of the ones somebody thought of.
 *
 * The origin is unroutable on purpose: nothing here fetches it, and a real host
 * would make a mistake in this function reachable rather than inert.
 */
const RESOLUTION_ORIGIN = 'https://placeholder.invalid';

export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return DEFAULT_RETURN_TO;
  try {
    const url = new URL(value, RESOLUTION_ORIGIN);
    if (url.origin !== RESOLUTION_ORIGIN) return DEFAULT_RETURN_TO;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_RETURN_TO;
  }
}

/**
 * The sign-in page, told where the visitor was headed.
 *
 * `/login` rather than `/auth/login` so the reason is stated before the
 * redirect to Auth0 takes the page away: somebody bounced out of a page they
 * were using needs to be told the session ended, not silently handed a login
 * form they did not ask for.
 */
export function signedOutRedirect(returnTo?: string): string {
  const params = new URLSearchParams({ returnTo: safeReturnTo(returnTo) });
  return `/login?${params.toString()}`;
}
