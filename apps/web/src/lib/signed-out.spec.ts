import { describe, expect, it } from 'vitest';
import { safeReturnTo, signedOutRedirect } from './signed-out';

/**
 * The one rule worth a test here is the refusal: `returnTo` reaches this from
 * a URL, so anything it accepts is somewhere an attacker can send a seller
 * mid-sign-in.
 */

describe('safeReturnTo', () => {
  it('keeps a path on this site', () => {
    expect(safeReturnTo('/shipments?id=SHP-1')).toBe('/shipments?id=SHP-1');
  });

  it('falls back when there is nothing to return to', () => {
    expect(safeReturnTo(undefined)).toBe('/chat');
    expect(safeReturnTo('')).toBe('/chat');
  });

  it('refuses an absolute URL', () => {
    expect(safeReturnTo('https://evil.example/steal')).toBe('/chat');
  });

  it('refuses a protocol-relative URL', () => {
    // The one that reads as a path and is not.
    expect(safeReturnTo('//evil.example')).toBe('/chat');
  });
});

describe('signedOutRedirect', () => {
  it('sends the visitor to the sign-in page with their destination', () => {
    expect(signedOutRedirect('/team')).toBe('/login?returnTo=%2Fteam');
  });
});
