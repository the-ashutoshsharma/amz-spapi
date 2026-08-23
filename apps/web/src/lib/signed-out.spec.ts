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

describe('values that leave the origin without looking like it', () => {
  // Browsers normalise a backslash to a forward slash in the authority
  // position, so this is `//evil.example` in disguise and resolves off-site.
  // A prefix check passes it; asking the URL parser does not.
  it.each([
    ['/\\evil.example', 'backslash reads as a second slash'],
    ['/\\\\evil.example', 'two backslashes, same thing'],
    ['\\/evil.example', 'leading backslash'],
    ['https://evil.example', 'absolute'],
    ['//evil.example', 'protocol-relative'],
    ['javascript:alert(1)', 'not a path at all'],
  ])('refuses %s (%s)', (value) => {
    expect(safeReturnTo(value)).toBe('/chat');
  });

  it('keeps a real path, with its query and hash', () => {
    expect(safeReturnTo('/shipments?id=7#items')).toBe('/shipments?id=7#items');
  });

  it('keeps a path that merely contains a backslash later on', () => {
    // Only the authority position matters; a backslash in a path segment is
    // just a character and refusing it would be superstition.
    expect(safeReturnTo('/documents/a%5Cb')).toBe('/documents/a%5Cb');
  });
});
