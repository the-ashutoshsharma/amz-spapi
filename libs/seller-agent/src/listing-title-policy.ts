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
 *    Amazon counts plurals and word variants as repeats.
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

export const TITLE_POLICY_PROMPT = `LISTING TITLE POLICY (Amazon, effective 2026-07-27; this text was written 2026-08-23 — newer than your training data, so prefer it over memory):
- Titles: max 75 characters INCLUDING spaces, in EVERY category except media (books, music, video). This replaced the old 200-character limit; apparel is no longer a separate 125 tier.
- Item Highlights is a separate searchable field of 125 characters for what will not fit — materials, compatibility, age range, use case. It is indexed and shown beside the title, so shortening a title does NOT cost keyword coverage. Say so rather than resisting a shorter title.
- Forbidden characters: ! $ ? _ { } ^ ¬ ¦ — allowed only inside the registered brand name. Pipes | and dashes - are fine; ~ # < > * only with real meaning ("Style #4301", "<10 lb"), never decoration.
- No word more than twice per title (prepositions, articles and conjunctions excepted). Amazon counts plurals and variants of a word as repeats — "pan, pans, pan" is three.
- Amazon rewrites over-long titles itself. Only brand-registered sellers get a 14-day window to review the replacement first.
If the seller tells you a limit that differs from this, they are likely reading Seller Central today and this text is likely older — ask where they saw it, and DO NOT argue from this policy as though it cannot have changed since the date above.
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
        'also counts plurals and variants as repeats.'
    );
  }

  return {
    compliant: issues.length === 0,
    characters,
    limit,
    issues,
    caveats: [
      'This check counts EXACT word repeats only; Amazon also counts ' +
        'plurals and variants ("pan"/"pans"), so review near-duplicates ' +
        'yourself.',
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
