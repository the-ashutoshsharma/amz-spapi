import { validateListingTitle } from './listing-title-policy';

/**
 * The January 2025 title policy, enforced rather than remembered. Every
 * failure here is a recommendation that gets a seller's listing flagged: an
 * over-long title presented as fine, a "$" waved through, a keyword repeated
 * three times because only exact matches were counted.
 */

describe('validateListingTitle', () => {
  it('passes a compliant title and still states its caveats', () => {
    const check = validateListingTitle(
      'Gran Del Val Panama Geisha Whole Bean Coffee, Washed, 250g'
    );
    expect(check.compliant).toBe(true);
    expect(check.issues).toEqual([]);
    // The caveats are part of the answer: what this check cannot see, the
    // model must say rather than silently certify.
    // The source says nothing about plurals; it says brand names count to the
    // same limit unless part of one appears in a different context.
    expect(check.caveats.join(' ')).toMatch(/Old Navy/);
  });

  it('measures length including spaces, against the 75-character limit', () => {
    const long = 'word '.repeat(50).trim(); // 249 characters
    const check = validateListingTitle(long);
    expect(check.compliant).toBe(false);
    expect(check.characters).toBe(249);
    expect(check.issues[0]).toMatch(/over the 75-character limit.*174/);
  });

  it('keeps the old 200 for media, which the 2026 rule excepts', () => {
    const title = 'x'.repeat(150);
    // 150 is over the general limit and under the media one, so the flag is
    // the whole difference between a compliant title and a rewritten listing.
    expect(validateListingTitle(title).compliant).toBe(false);
    expect(validateListingTitle(title).limit).toBe(75);

    const media = validateListingTitle(title, { media: true });
    expect(media.compliant).toBe(true);
    expect(media.limit).toBe(200);
  });

  it('points a non-media title at Item Highlights rather than at cutting keywords', () => {
    // The old policy's 200 characters did not go away, they moved. A model
    // that does not know this argues against shortening, which is what
    // happened to a seller who was reading the current rule correctly.
    const check = validateListingTitle('x'.repeat(120));
    expect(check.caveats.join(' ')).toMatch(/Item Highlights/);
    expect(check.caveats.join(' ')).toMatch(/not a reason to drop keywords/);
  });

  it('names each forbidden character it finds', () => {
    const check = validateListingTitle('Amazing Deal! Only $9.99 Best_Value');
    expect(check.compliant).toBe(false);
    expect(check.issues[0]).toContain('"!"');
    expect(check.issues[0]).toContain('"$"');
    expect(check.issues[0]).toContain('"_"');
    expect(check.issues[0]).toMatch(/brand name/);
  });

  it('allows pipes and dashes — the separators Amazon still permits', () => {
    const check = validateListingTitle(
      'French Press Coffee Maker - Stainless Steel | 1.6L'
    );
    expect(check.compliant).toBe(true);
  });

  it('flags a word used three times, but not exempt little words', () => {
    const check = validateListingTitle(
      'Coffee Maker for Coffee Lovers with Coffee Scoop and Filters and Stand'
    );
    expect(check.compliant).toBe(false);
    expect(check.issues[0]).toMatch(/"coffee" appears 3 times/);
    // "and" appears twice+ but is a conjunction — exempt, never flagged.
    expect(check.issues.join(' ')).not.toMatch(/"and"/);
  });

  it('permits a word exactly twice', () => {
    const check = validateListingTitle(
      'Coffee Maker with Coffee Scoop, Borosilicate Glass, 600ml'
    );
    expect(check.compliant).toBe(true);
  });
});
