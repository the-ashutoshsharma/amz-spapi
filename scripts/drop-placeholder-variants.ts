#!/usr/bin/env node
/**
 * Remove the variant rows that only ever existed to satisfy a required field.
 *
 * Every product used to be created with one variant — `isDefault: true`, no
 * options — because `ProductListing.variantId` was required. That row then
 * displayed as "Variants (1) — Default variant" on the product page, repeating
 * the ASIN of the listing beside it, which reads as a variation family nobody
 * created. `variantId` is optional now, so the placeholders are unreferenced
 * bookkeeping.
 *
 * A placeholder is a product's ONLY variant, carrying no options. A product
 * with two variants has a family even if neither names an option, and a single
 * variant that carries options is a family of one — neither is touched.
 *
 * Usage:
 *   npx tsx --env-file=apps/web/.env.local scripts/drop-placeholder-variants.ts plan
 *   npx tsx --env-file=apps/web/.env.local scripts/drop-placeholder-variants.ts apply
 *
 * `plan` is the default and writes nothing. `apply` clears the pointer on the
 * affected listings FIRST, then deletes the variants — in that order, because
 * the reverse leaves listings pointing at documents that no longer exist, and a
 * crash between the two would strand them there permanently. Doing it this way
 * the worst interruption leaves unreferenced variants, which is exactly the
 * state this script exists to clean and can simply be re-run.
 *
 * Idempotent: re-running finds nothing once converged.
 */
import { collectionName, executeQuery } from '@amz-spapi/couchbase-utils';

const SCOPE = 'catalog';
const VARIANTS = collectionName(SCOPE, 'variants');
const LISTINGS = collectionName(SCOPE, 'listings');

type Placeholder = { variantId: string; productId: string; userId: string };

/** A product's only variant, carrying no options. */
async function findPlaceholders(): Promise<Placeholder[]> {
  const { rows } = await executeQuery<Placeholder>(
    SCOPE,
    `SELECT v.variantId, v.productId, v.userId
       FROM \`${VARIANTS}\` AS v
      WHERE v.\`deleted\` IS MISSING
        AND ARRAY_LENGTH(IFMISSINGORNULL(v.\`options\`, [])) = 0
        AND 1 = (
          SELECT RAW COUNT(*) FROM \`${VARIANTS}\` AS peer
           WHERE peer.productId = v.productId AND peer.\`deleted\` IS MISSING
        )[0]`,
    { readonly: true }
  );
  return rows;
}

async function countListingsFor(variantIds: string[]): Promise<number> {
  if (!variantIds.length) return 0;
  const { rows } = await executeQuery<number>(
    SCOPE,
    `SELECT RAW COUNT(*) FROM \`${LISTINGS}\` AS l
      WHERE l.variantId IN $variantIds AND l.\`deleted\` IS MISSING`,
    { parameters: { variantIds }, readonly: true }
  );
  return rows[0] ?? 0;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('apply');
  const placeholders = await findPlaceholders();
  const variantIds = placeholders.map((p) => p.variantId);
  const listings = await countListingsFor(variantIds);

  console.log(
    `${placeholders.length} placeholder variant(s), referenced by ${listings} listing(s).`
  );
  if (!placeholders.length) return;
  if (!apply) {
    console.log('PLAN only — nothing written. Pass `apply` to converge.');
    return;
  }

  // Pointer first: see the ordering note above.
  const { rows: cleared } = await executeQuery<number>(
    SCOPE,
    `UPDATE \`${LISTINGS}\` AS l UNSET l.variantId
      WHERE l.variantId IN $variantIds AND l.\`deleted\` IS MISSING
      RETURNING RAW 1`,
    { parameters: { variantIds } }
  );

  const { rows: dropped } = await executeQuery<number>(
    SCOPE,
    `DELETE FROM \`${VARIANTS}\` AS v
      WHERE v.variantId IN $variantIds
      RETURNING RAW 1`,
    { parameters: { variantIds } }
  );

  console.log(
    `Cleared ${cleared.length} listing pointer(s); deleted ${dropped.length} variant(s).`
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
