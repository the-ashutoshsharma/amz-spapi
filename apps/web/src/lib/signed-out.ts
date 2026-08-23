/**
 * Where a request without a session goes, and how it gets back.
 *
 * Shared by the server gates (a dashboard route rendered for somebody whose
 * cookie has gone) and by the client's expiry dialog, because the rule that
 * matters is the same in both: a `returnTo` is only ever a path on this site.
 * Anything else — an absolute URL, a protocol-relative `//evil.example` — is an
 * open redirect wearing a helpful name, and Auth0 will reject it anyway.
 */

const DEFAULT_RETURN_TO = '/chat';

export function safeReturnTo(value: string | null | undefined): string {
  if (!value) return DEFAULT_RETURN_TO;
  if (!value.startsWith('/') || value.startsWith('//')) {
    return DEFAULT_RETURN_TO;
  }
  return value;
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
