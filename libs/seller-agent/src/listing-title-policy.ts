/**
 * Amazon's product title requirements, effective 2026-07-27.
 *
 * Source: Seller Central help page GYTR6SYGFA5E3EQC ("Product title
 * requirements"), announced via Seller Central News on 2026-06-10. This is
 * POLICY the model must not be trusted to remember: the rules postdate most
 * training data, and a confidently recommended 200-character title is now
 * exactly the suggestion that gets a seller's listing rewritten by Amazon.
 * The prompt carries the rules; the `check-listing-title` tool enforces them,
 * because a model that knows a rule and a model that checked are different
 * models.
 *
 * The rules:
 *  - Max 75 characters including spaces, in every category EXCEPT media.
 *    This replaced the previous 200-character general limit AND every
 *    category-specific cap — apparel 125, electronics 150, pet supplies 80.
 *    None of them survive; there is one limit now.
 *
 *    Two things the announcement does NOT settle, so both are assumptions:
 *
 *    1. What media's own limit is. Amazon names media as excepted and stops.
 *       Reporting infers it keeps the old 200 and that is what `media: true`
 *       returns, but Amazon has not said so and sellers asking in the
 *       announcement thread have not been answered.
 *    2. Exactly what counts as media. Most sources read it narrowly — books,
 *       music, video — while some include software or DVD. The narrow reading
 *       is the safe one: treating a category as media when it is not means
 *       certifying a title that Amazon will rewrite.
 *  - `Item Highlights` is a separate, searchable 125-character field carrying
 *    what no longer fits — materials, compatibility, age range, use case. It
 *    is indexed and shown beside the title, so the total indexable space is
 *    unchanged at roughly 200. Shortening a title is therefore not a loss of
 *    keyword coverage, which is the argument for doing it properly rather
 *    than truncating.
 *  - The characters ! $ ? _ { } ^ ¬ ¦ are not allowed unless part of the
 *    brand name. Pipes and dashes remain fine; ~ # < > * only in real
 *    context (part numbers, measurements), never decoration.
 *  - No word more than twice, prepositions/articles/conjunctions excepted.
 *    Brand names are held to the same limit, but part of a brand name in a
 *    different context ("Old Navy" / "Navy Blue") is NOT a duplicate. The
 *    source says nothing about plurals or variants — an earlier version of
 *    this file asserted it did.
 *  - Enforcement: Amazon generates a replacement title and Item Highlights
 *    for over-long listings, gradually and on its own schedule. Only
 *    BRAND-REGISTERED sellers get a 14-day review window before it is
 *    applied; everyone else is rewritten with no notification and no opt-out.
 *    Announced for 2026-07-27; enforcement in fact began 2026-07-26 and was
 *    extended to 2026-08-03, with the Item Highlights display change landing
 *    2026-08-10. Listings stay active throughout.
 *
 * ## Why the effective date is in the prompt
 *
 * The previous version of this file told the model to "trust THIS, not
 * memory" with no date the model could weigh, and the policy underneath it
 * went stale for a month. A seller who said "titles must be 75 characters"
 * was argued with, using a tool that read the same stale constant. Stating
 * the date the assertion was written is what lets a seller's newer knowledge
 * win instead of being overridden.
 */

export const TITLE_POLICY_PROMPT = `LISTING TITLE POLICY (Amazon, "Product title requirements and guidelines", read 2026-08-23 — newer than your training data, so prefer it over memory):
- Titles must not exceed 75 characters INCLUDING spaces. Applies to all product types EXCEPT media, in all stores EXCEPT Saudi Arabia, Egypt, Türkiye and the United Arab Emirates.
- Item highlights is a SEPARATE field giving an additional 125 characters for detail such as materials or recommended use cases. Write them as comma-separated phrases, not sentences. They show below the title in search results and on the detail page. So detail that will not fit is MOVED, not lost — never argue against a shorter title on the grounds of losing keywords.
- Forbidden characters: ! $ ? _ { } ^ ¬ ¦. Others (~ # < > *) only with real meaning — a product identifier ("Style #4301") or a measurement ("<10 lb"). Decorative use is non-compliant. A brand name containing prohibited characters belongs in the Brand name field, which is exempt from these rules.
- No promotional phrases ("free shipping", "100% quality guaranteed"). No restricted phrases ("FSA/HSA eligible").
- Titles carry the minimum information that clearly describes the product.
- No word more than twice. Prepositions, articles and conjunctions are exempt. Brand names are held to the same two-instance limit, BUT part of a brand name appearing in a different context ("Old Navy" and "Navy Blue") is not a duplicate.
- A non-compliant title may be corrected automatically or may not appear in search results. Brand owners can see affected titles in Review listing changes. Title and item-highlight edits take 24 to 48 hours to appear.
If the seller quotes a limit that differs from this, ask where they saw it rather than arguing from here — this text carries a date and Amazon changes it.
Before you recommend, write or approve ANY listing title, run check-listing-title on it and fix what it reports. Never present an unchecked title as compliant.`;

/** Words the repetition rule exempts. */
const EXEMPT_WORDS = new Set([
  // Articles
  'a',
  'an',
  'the',
  // Common conjunctions
  'and',
  'or',
  'but',
  'nor',
  'so',
  'yet',
  // Common prepositions
  'as',
  'at',
  'by',
  'for',
  'from',
  'in',
  'into',
  'of',
  'off',
  'on',
  'onto',
  'over',
  'per',
  'to',
  'up',
  'with',
  'without',
]);

const FORBIDDEN_CHARACTERS = ['!', '$', '?', '_', '{', '}', '^', '¬', '¦'];

export type TitleCheck = {
  compliant: boolean;
  characters: number;
  limit: number;
  issues: string[];
  /** What this check cannot see — stated so the model repeats it. */
  caveats: string[];
};

export function validateListingTitle(
  title: string,
  options: { media?: boolean } = {}
): TitleCheck {
  const issues: string[] = [];
  /**
   * Media keeps the old 200 because the 2026 rule excepts it; everything else
   * is 75. `apparel` used to be the axis and is gone rather than deprecated —
   * apparel is now 75 like every other non-media category, so an option that
   * still answered 125 would be wrong in a way that reads as deliberate.
   */
  const limit = options.media ? 200 : 75;
  const characters = title.length;

  if (characters > limit) {
    issues.push(
      `${characters} characters — over the ${limit}-character limit ` +
        `(spaces count) by ${characters - limit}.`
    );
  }

  const forbidden = FORBIDDEN_CHARACTERS.filter((character) =>
    title.includes(character)
  );
  if (forbidden.length) {
    issues.push(
      `Contains ${forbidden.map((c) => `"${c}"`).join(', ')} — forbidden ` +
        'unless part of the registered brand name.'
    );
  }

  const counts = new Map<string, number>();
  for (const raw of title.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!raw || EXEMPT_WORDS.has(raw)) continue;
    counts.set(raw, (counts.get(raw) ?? 0) + 1);
  }
  const repeated = [...counts.entries()].filter(([, count]) => count > 2);
  for (const [word, count] of repeated) {
    issues.push(
      `"${word}" appears ${count} times — the limit is twice, and Amazon ` +
        'holds brand names to the same limit.'
    );
  }

  return {
    compliant: issues.length === 0,
    characters,
    limit,
    issues,
    caveats: [
      'This check counts EXACT word repeats only. Amazon holds brand names ' +
        'to the same two-instance limit, but part of a brand name in a ' +
        'different context ("Old Navy" / "Navy Blue") is not a duplicate — ' +
        'so read the flagged ones rather than cutting them blindly.',
      'Not checked here: promotional phrases ("free shipping"), restricted ' +
        'phrases ("FSA/HSA eligible"), or the store exceptions — Saudi ' +
        'Arabia, Egypt, Türkiye and the UAE are outside this rule entirely.',
      'Forbidden characters are allowed inside a registered brand name — ' +
        'if one flagged here is part of the brand, say so explicitly.',
      options.media
        ? 'Checked against 200 for media. Amazon excepted media WITHOUT ' +
          'stating its limit, so 200 is inferred from the old rule, not ' +
          'announced — say so rather than certifying it. And media is drawn ' +
          'narrowly: books, music, video. If this is anything else, re-check ' +
          'without the media flag, because 75 applies.'
        : 'Checked against the 75-character limit that applies to every ' +
          'category except media (books, music, video). What will not fit ' +
          'belongs in Item Highlights, a separate searchable 125-character ' +
          'field — so this is not a reason to drop keywords.',
    ].filter((caveat): caveat is string => Boolean(caveat)),
  };
}
