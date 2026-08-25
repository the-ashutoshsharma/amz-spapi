import crypto from 'node:crypto';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  SpApiClient,
  type ListingsPatchOperation,
} from '@farvisionllc/sp-client';
import {
  executeQuery,
  getDocument,
  upsertDocument,
  collectionName,
} from '@amz-spapi/couchbase-utils';
import { createAssetS3Client, getAsset } from './media-assets';
import {
  calculateContributionMargin,
  resolveLandedCost,
} from './landed-cost';

/**
 * Listing writes — the guarded path to the live listing:
 * 1. SNAPSHOT the current submitted attributes (our undo button; Amazon has
 *    none) into catalog.listing_versions.
 * 2. PREVIEW: the exact patch in Amazon's VALIDATION_PREVIEW mode — a real
 *    dry run with zero effect on the listing.
 * 3. APPLY: same patch for real (behind chat-side human approval), then the
 *    caller re-reads and surfaces Amazon's issues.
 * 4. REVERT: re-patch from a stored snapshot.
 *
 * Amazon fetches image URLs unauthenticated, so assets are handed over as
 * S3 presigned GET URLs (fetch happens within minutes of submission).
 * TODO(production): serve from a public/CDN prefix instead — presigned URLs
 * inherit the signing credential's lifetime.
 */

const SCOPE = 'catalog';
const VERSIONS_COLLECTION = 'listing_versions';
const SNAPSHOT_KEEP = 10;
const PRESIGN_EXPIRY_SECONDS = 6 * 60 * 60;

export const IMAGE_SLOT_ATTRIBUTES = [
  'main_product_image_locator',
  ...Array.from(
    { length: 8 },
    (_, i) => `other_product_image_locator_${i + 1}`
  ),
] as const;

export type ListingSnapshot = {
  snapshotId: string;
  userId: string;
  sku: string;
  productType: string;
  capturedAt: number;
  /** Full submitted attribute map at capture time. */
  attributes: Record<string, unknown>;
};

function safeUserPart(userId: string): string {
  return crypto.createHash('sha256').update(userId).digest('hex').slice(0, 24);
}

function snapshotDocKey(userId: string, snapshotId: string): string {
  return `listing-ver::${safeUserPart(userId)}::${snapshotId}`;
}

export type ListingWritesDeps = {
  userId: string;
  sellerId: string;
  marketplaceId: string;
  spClient: SpApiClient;
  /** Optional hard allowlist (env LISTING_WRITE_SKU_ALLOWLIST): when set,
   * apply/revert refuse every other SKU — the training-wheels rung. */
  skuAllowlist?: string[];
};

function assertSkuAllowed(deps: ListingWritesDeps, sku: string): void {
  if (!deps.skuAllowlist?.length) return;
  if (!deps.skuAllowlist.includes(sku)) {
    throw new Error(
      `SKU ${sku} is not in LISTING_WRITE_SKU_ALLOWLIST — listing writes are ` +
        'restricted to the configured test SKUs.'
    );
  }
}

async function presignAssetUrl(
  userId: string,
  assetId: string
): Promise<string> {
  const asset = await getAsset(assetId);
  if (!asset || asset.userId !== userId || asset.status !== 'uploaded') {
    throw new Error(
      `Asset ${assetId} not found — use asset ids from this conversation's photos.`
    );
  }
  if (!asset.mimeType.startsWith('image/')) {
    throw new Error(`Asset ${assetId} is not an image.`);
  }
  return getSignedUrl(
    createAssetS3Client(),
    new GetObjectCommand({
      Bucket: asset.storage.bucket,
      Key: asset.storage.key,
    }),
    { expiresIn: PRESIGN_EXPIRY_SECONDS }
  );
}

async function fetchListing(deps: ListingWritesDeps, sku: string) {
  const listing = await deps.spClient.getListingsItem({
    sku,
    sellerId: deps.sellerId,
    includedData: ['summaries', 'attributes', 'issues', 'offers'],
  });
  const summary = (
    listing?.summaries as Array<{ productType?: string }> | undefined
  )?.[0];
  const productType = summary?.productType;
  if (!productType) {
    throw new Error(
      `Could not resolve the product type for SKU ${sku} — the listing may not exist.`
    );
  }
  return {
    productType,
    attributes: (listing?.attributes ?? {}) as Record<string, unknown>,
    issues: listing?.issues ?? [],
    offers: (listing?.offers ?? []) as Array<Record<string, unknown>>,
  };
}

export function extractCurrentPrice(
  attributes: Record<string, unknown>,
  offers?: unknown[]
): { amount?: number; currency?: string } {
  // 1. From offers
  const firstOffer = (
    offers as
      | Array<{ price?: { amount?: string | number; currencyCode?: string } }>
      | undefined
  )?.[0];
  if (firstOffer?.price?.amount !== undefined) {
    const amt =
      typeof firstOffer.price.amount === 'number'
        ? firstOffer.price.amount
        : parseFloat(firstOffer.price.amount);
    if (!isNaN(amt)) {
      return {
        amount: amt,
        currency: firstOffer.price.currencyCode ?? 'USD',
      };
    }
  }

  // 2. From attributes.purchasable_offer
  const purchasableOffer = attributes['purchasable_offer'] as
    | Array<{
        currency?: string;
        our_price?: Array<{
          schedule?: Array<{ value_with_tax?: number | string }>;
        }>;
      }>
    | undefined;
  const firstPo = purchasableOffer?.[0];
  const valueWithTax = firstPo?.our_price?.[0]?.schedule?.[0]?.value_with_tax;
  if (valueWithTax !== undefined) {
    const amt =
      typeof valueWithTax === 'number'
        ? valueWithTax
        : parseFloat(String(valueWithTax));
    if (!isNaN(amt)) {
      return { amount: amt, currency: firstPo?.currency ?? 'USD' };
    }
  }

  return {};
}

export function buildPricePatches(params: {
  marketplaceId: string;
  price: number;
  currency?: string;
}): ListingsPatchOperation[] {
  return [
    {
      op: 'replace',
      path: '/attributes/purchasable_offer',
      value: [
        {
          marketplace_id: params.marketplaceId,
          currency: params.currency || 'USD',
          our_price: [
            {
              schedule: [
                {
                  value_with_tax: params.price,
                },
              ],
            },
          ],
        },
      ],
    },
  ];
}

/** Current vs proposed value for each image slot the patch touches. */
function imageDiff(
  attributes: Record<string, unknown>,
  patches: ListingsPatchOperation[]
): Array<{ slot: string; current?: string; proposed?: string }> {
  return patches.map((patch) => {
    const slot = patch.path.replace('/attributes/', '');
    const currentValue = attributes[slot] as
      | Array<{ media_location?: string }>
      | undefined;
    return {
      slot,
      current: currentValue?.[0]?.media_location,
      proposed: (patch.value?.[0] as { media_location?: string } | undefined)
        ?.media_location,
    };
  });
}

/**
 * Ordered images → slot patches: index 0 is the MAIN image, 1..8 the other
 * slots. Only provided slots are touched unless clearRemaining removes the
 * rest (explicit choice, never the default).
 */
async function buildImagePatches(
  deps: ListingWritesDeps,
  params: {
    images: Array<{ assetId: string }>;
    currentAttributes: Record<string, unknown>;
    clearRemaining?: boolean;
  }
): Promise<ListingsPatchOperation[]> {
  if (params.images.length === 0) {
    throw new Error('Provide at least one image (index 0 becomes MAIN).');
  }
  if (params.images.length > 9) {
    throw new Error('At most 9 images (1 main + 8 others).');
  }

  const patches: ListingsPatchOperation[] = [];
  for (let i = 0; i < params.images.length; i++) {
    const url = await presignAssetUrl(deps.userId, params.images[i].assetId);
    patches.push({
      op: 'replace',
      path: `/attributes/${IMAGE_SLOT_ATTRIBUTES[i]}`,
      value: [{ marketplace_id: deps.marketplaceId, media_location: url }],
    });
  }
  if (params.clearRemaining) {
    for (let i = params.images.length; i < IMAGE_SLOT_ATTRIBUTES.length; i++) {
      const slot = IMAGE_SLOT_ATTRIBUTES[i];
      if (params.currentAttributes[slot] !== undefined) {
        patches.push({ op: 'delete', path: `/attributes/${slot}` });
      }
    }
  }
  return patches;
}

export function createListingWrites(deps: ListingWritesDeps) {
  return {
    /** Amazon-side dry run: submitted patch, zero effect, real validation. */
    async previewImageUpdate(params: {
      sku: string;
      images: Array<{ assetId: string }>;
      clearRemaining?: boolean;
    }) {
      assertSkuAllowed(deps, params.sku);
      const listing = await fetchListing(deps, params.sku);
      const patches = await buildImagePatches(deps, {
        images: params.images,
        currentAttributes: listing.attributes,
        clearRemaining: params.clearRemaining,
      });
      const result = await deps.spClient.patchListingsItem({
        sku: params.sku,
        sellerId: deps.sellerId,
        productType: listing.productType,
        patches,
        mode: 'VALIDATION_PREVIEW',
      });
      return {
        status: result?.status,
        issues: result?.issues ?? [],
        diff: imageDiff(listing.attributes, patches),
      };
    },

    /** The real write — snapshot first, patch, report the snapshot id. */
    async applyImageUpdate(params: {
      sku: string;
      images: Array<{ assetId: string }>;
      clearRemaining?: boolean;
    }) {
      assertSkuAllowed(deps, params.sku);
      const listing = await fetchListing(deps, params.sku);

      const snapshotId = `lver_${crypto.randomUUID()}`;
      const snapshot: ListingSnapshot = {
        snapshotId,
        userId: deps.userId,
        sku: params.sku,
        productType: listing.productType,
        capturedAt: Date.now(),
        attributes: listing.attributes,
      };
      await upsertDocument(
        SCOPE,
        VERSIONS_COLLECTION,
        snapshotDocKey(deps.userId, snapshotId),
        snapshot
      );
      await pruneSnapshots(deps.userId, params.sku);

      const patches = await buildImagePatches(deps, {
        images: params.images,
        currentAttributes: listing.attributes,
        clearRemaining: params.clearRemaining,
      });
      const result = await deps.spClient.patchListingsItem({
        sku: params.sku,
        sellerId: deps.sellerId,
        productType: listing.productType,
        patches,
      });

      return {
        status: result?.status,
        submissionId: result?.submissionId,
        issues: result?.issues ?? [],
        snapshotId,
        diff: imageDiff(listing.attributes, patches),
      };
    },

    /** Restore image slots from a snapshot (latest for the SKU by default). */
    async revertImages(params: { sku: string; snapshotId?: string }) {
      assertSkuAllowed(deps, params.sku);
      const snapshot = params.snapshotId
        ? await getDocument<ListingSnapshot>(
            SCOPE,
            VERSIONS_COLLECTION,
            snapshotDocKey(deps.userId, params.snapshotId)
          )
        : await latestSnapshot(deps.userId, params.sku);
      if (!snapshot || snapshot.userId !== deps.userId) {
        throw new Error(`No snapshot found for SKU ${params.sku}.`);
      }

      const patches: ListingsPatchOperation[] = [];
      for (const slot of IMAGE_SLOT_ATTRIBUTES) {
        const value = snapshot.attributes[slot];
        if (value !== undefined) {
          patches.push({
            op: 'replace',
            path: `/attributes/${slot}`,
            value: value as Array<Record<string, unknown>>,
          });
        } else {
          patches.push({ op: 'delete', path: `/attributes/${slot}` });
        }
      }
      // delete-on-missing only makes sense for slots the listing has now
      const listing = await fetchListing(deps, params.sku);
      const effective = patches.filter(
        (patch) =>
          patch.op !== 'delete' ||
          listing.attributes[patch.path.replace('/attributes/', '')] !==
            undefined
      );
      if (effective.length === 0) {
        return {
          status: 'NOTHING_TO_REVERT',
          issues: [],
          snapshotId: snapshot.snapshotId,
        };
      }

      const result = await deps.spClient.patchListingsItem({
        sku: params.sku,
        sellerId: deps.sellerId,
        productType: snapshot.productType,
        patches: effective,
      });
      return {
        status: result?.status,
        submissionId: result?.submissionId,
        issues: result?.issues ?? [],
        snapshotId: snapshot.snapshotId,
      };
    },

    /** Re-read after a write so the agent can surface Amazon's issues. */
    async checkListing(params: { sku: string }) {
      const listing = await fetchListing(deps, params.sku);
      return { productType: listing.productType, issues: listing.issues };
    },

    /**
     * Complete price analysis:
     * Current price → FOEP → Amazon fees → Landed cost → Contribution margin → Verdict
     */
    async checkPrice(params: {
      sku: string;
      price?: number;
      currency?: string;
    }) {
      const listing = await fetchListing(deps, params.sku);
      const current = extractCurrentPrice(listing.attributes, listing.offers);
      const targetPrice = params.price ?? current.amount;
      const currency = params.currency ?? current.currency ?? 'USD';

      if (targetPrice === undefined || targetPrice <= 0) {
        throw new Error(
          `Could not determine price for SKU ${params.sku}. Please provide a specific price.`
        );
      }

      // Parallel reads: FOEP, Fee Estimate, Landed Cost
      const [foep, feeEstimate, landedCost] = await Promise.all([
        deps.spClient.getFeaturedOfferExpectedPrice({
          sku: params.sku,
          marketplaceId: deps.marketplaceId,
        }),
        deps.spClient.getMyFeesEstimateForSKU({
          sku: params.sku,
          price: targetPrice,
          currency,
          marketplaceId: deps.marketplaceId,
        }),
        resolveLandedCost({
          userId: deps.userId,
          sku: params.sku,
          marketplaceId: deps.marketplaceId,
        }),
      ]);

      const costBasis = landedCost?.unitCost ?? 0;
      const margin = calculateContributionMargin({
        price: targetPrice,
        fees: feeEstimate.totalFees,
        landedCost: costBasis,
      });

      // Price change percentage if current price is known and price is proposed
      let changePercent: number | undefined;
      if (current.amount && params.price) {
        changePercent =
          Math.round(
            ((params.price - current.amount) / current.amount) * 10000
          ) / 100;
      }

      // Determine verdict & warnings
      let verdict: 'PASS' | 'MARGIN_FLOOR_BREACH' | 'MISSING_COST_BASIS' =
        'PASS';
      const warnings: string[] = [];

      if (!landedCost) {
        verdict = 'MISSING_COST_BASIS';
        warnings.push(
          `No landed cost or COGS found for SKU ${params.sku}. Contribution margin cannot be guaranteed without a cost basis.`
        );
      } else if (!margin.floorSatisfied) {
        verdict = 'MARGIN_FLOOR_BREACH';
        warnings.push(
          `Proposed price ${currency} ${targetPrice.toFixed(
            2
          )} breaches the margin floor! Landed cost is ${currency} ${costBasis.toFixed(
            2
          )} and fees are ${currency} ${feeEstimate.totalFees.toFixed(
            2
          )}, producing a negative contribution margin of ${currency} ${margin.contributionMargin.toFixed(
            2
          )} (${margin.contributionMarginPercent}%).`
        );
      }

      if (foep.status === 'OFFER_NOT_ELIGIBLE') {
        warnings.push(
          'Amazon reports this offer is currently NOT ELIGIBLE for the Featured Offer (Buy Box). Repricing may not win the Buy Box until eligibility issues (account health, shipping performance, or condition) are resolved.'
        );
      } else if (foep.expectedPrice && targetPrice > foep.expectedPrice) {
        warnings.push(
          `Proposed price ${currency} ${targetPrice.toFixed(
            2
          )} is above the Featured Offer Expected Price (${currency} ${foep.expectedPrice.toFixed(
            2
          )}).`
        );
      }

      if (changePercent !== undefined && Math.abs(changePercent) > 20) {
        warnings.push(
          `Proposed price change is ${
            changePercent > 0 ? '+' : ''
          }${changePercent.toFixed(
            1
          )}%, which exceeds the standard ±20% single-turn safety guardrail.`
        );
      }

      return {
        sku: params.sku,
        productType: listing.productType,
        currentPrice: current.amount,
        proposedPrice: targetPrice,
        currency,
        changePercent,
        foep: {
          status: foep.status,
          expectedPrice: foep.expectedPrice,
          competingPrice: foep.competingPrice,
          competingOfferType: foep.competingOfferType,
        },
        fees: {
          referralFee: feeEstimate.referralFee,
          fulfillmentFee: feeEstimate.fulfillmentFee,
          totalFees: feeEstimate.totalFees,
          feeDetailList: feeEstimate.feeDetailList,
        },
        landedCost: landedCost
          ? {
              unitCost: landedCost.unitCost,
              currency: landedCost.currency,
              source: landedCost.source,
              reference: landedCost.reference,
            }
          : null,
        margin: {
          contributionMargin: margin.contributionMargin,
          contributionMarginPercent: margin.contributionMarginPercent,
          floorSatisfied: margin.floorSatisfied,
          breachAmount: margin.breachAmount,
        },
        verdict,
        warnings,
      };
    },

    /** Amazon-side dry run of price update (VALIDATION_PREVIEW). */
    async previewPriceUpdate(params: {
      sku: string;
      price: number;
      currency?: string;
    }) {
      assertSkuAllowed(deps, params.sku);
      if (params.price <= 0) {
        throw new Error('Price must be greater than 0.');
      }

      const listing = await fetchListing(deps, params.sku);
      const current = extractCurrentPrice(listing.attributes, listing.offers);
      const currency = params.currency ?? current.currency ?? 'USD';

      const patches = buildPricePatches({
        marketplaceId: deps.marketplaceId,
        price: params.price,
        currency,
      });

      const result = await deps.spClient.patchListingsItem({
        sku: params.sku,
        sellerId: deps.sellerId,
        productType: listing.productType,
        patches,
        mode: 'VALIDATION_PREVIEW',
      });

      const check = await this.checkPrice({
        sku: params.sku,
        price: params.price,
        currency,
      });

      return {
        status: result?.status,
        issues: result?.issues ?? [],
        sku: params.sku,
        currentPrice: current.amount,
        proposedPrice: params.price,
        currency,
        margin: check.margin,
        warnings: check.warnings,
      };
    },

    /**
     * WRITE price update to LIVE Amazon listing (Approval Gated).
     * Refuses price changes that breach the margin floor or exceed safety limits.
     */
    async applyPriceUpdate(params: {
      sku: string;
      price: number;
      currency?: string;
      maxChangePercent?: number;
    }) {
      assertSkuAllowed(deps, params.sku);
      if (params.price <= 0) {
        throw new Error('Price must be greater than 0.');
      }

      // Check current price and margin floor
      const check = await this.checkPrice({
        sku: params.sku,
        price: params.price,
        currency: params.currency,
      });

      if (check.verdict === 'MARGIN_FLOOR_BREACH') {
        throw new Error(
          `Refusing price change for SKU ${
            params.sku
          }: proposed price ${check.currency} ${params.price.toFixed(
            2
          )} breaches the margin floor (negative contribution margin of ${
            check.currency
          } ${check.margin.contributionMargin.toFixed(2)} / ${
            check.margin.contributionMarginPercent
          }%). Landed cost is ${check.currency} ${check.landedCost?.unitCost.toFixed(
            2
          )}.`
        );
      }

      // Guardrail on max percentage move (default ±20%)
      const maxChange = params.maxChangePercent ?? 20;
      if (
        check.changePercent !== undefined &&
        Math.abs(check.changePercent) > maxChange
      ) {
        throw new Error(
          `Refusing price change for SKU ${params.sku}: price change of ${
            check.changePercent > 0 ? '+' : ''
          }${check.changePercent.toFixed(
            1
          )}% exceeds the ±${maxChange}% single-call safety threshold (from ${
            check.currency
          } ${check.currentPrice?.toFixed(2)} to ${
            check.currency
          } ${params.price.toFixed(2)}).`
        );
      }

      const listing = await fetchListing(deps, params.sku);

      // 1. Snapshot prior attributes for rollback and audit
      const snapshotId = `lver_${crypto.randomUUID()}`;
      const snapshot: ListingSnapshot = {
        snapshotId,
        userId: deps.userId,
        sku: params.sku,
        productType: listing.productType,
        capturedAt: Date.now(),
        attributes: listing.attributes,
      };
      await upsertDocument(
        SCOPE,
        VERSIONS_COLLECTION,
        snapshotDocKey(deps.userId, snapshotId),
        snapshot
      );
      await pruneSnapshots(deps.userId, params.sku);

      // 2. Patch purchasable_offer on Amazon
      const patches = buildPricePatches({
        marketplaceId: deps.marketplaceId,
        price: params.price,
        currency: check.currency,
      });

      const result = await deps.spClient.patchListingsItem({
        sku: params.sku,
        sellerId: deps.sellerId,
        productType: listing.productType,
        patches,
      });

      return {
        status: result?.status,
        submissionId: result?.submissionId,
        issues: result?.issues ?? [],
        snapshotId,
        sku: params.sku,
        previousPrice: check.currentPrice,
        newPrice: params.price,
        currency: check.currency,
        margin: check.margin,
        warnings: check.warnings,
      };
    },

    /** Restore price from a snapshot. */
    async revertPrice(params: { sku: string; snapshotId?: string }) {
      assertSkuAllowed(deps, params.sku);
      const snapshot = params.snapshotId
        ? await getDocument<ListingSnapshot>(
            SCOPE,
            VERSIONS_COLLECTION,
            snapshotDocKey(deps.userId, params.snapshotId)
          )
        : await latestSnapshot(deps.userId, params.sku);
      if (!snapshot || snapshot.userId !== deps.userId) {
        throw new Error(`No snapshot found for SKU ${params.sku}.`);
      }

      const previousPo = snapshot.attributes['purchasable_offer'];
      if (!previousPo) {
        throw new Error(
          `Snapshot ${snapshot.snapshotId} did not contain a purchasable_offer attribute.`
        );
      }

      const patches: ListingsPatchOperation[] = [
        {
          op: 'replace',
          path: '/attributes/purchasable_offer',
          value: previousPo as Array<Record<string, unknown>>,
        },
      ];

      const result = await deps.spClient.patchListingsItem({
        sku: params.sku,
        sellerId: deps.sellerId,
        productType: snapshot.productType,
        patches,
      });

      return {
        status: result?.status,
        submissionId: result?.submissionId,
        issues: result?.issues ?? [],
        snapshotId: snapshot.snapshotId,
      };
    },
  };
}

export type SellerListingWritesImpl = ReturnType<typeof createListingWrites>;

async function latestSnapshot(
  userId: string,
  sku: string
): Promise<ListingSnapshot | null> {
  const result = await executeQuery<ListingSnapshot>(
    SCOPE,
    `SELECT RAW v FROM \`${collectionName(SCOPE, VERSIONS_COLLECTION)}\` v
     WHERE v.userId = $userId AND v.sku = $sku
     ORDER BY v.capturedAt DESC
     LIMIT 1`,
    { parameters: { userId, sku } }
  );
  return result.rows[0] ?? null;
}

async function pruneSnapshots(userId: string, sku: string): Promise<void> {
  try {
    await executeQuery(
      SCOPE,
      `DELETE FROM \`${collectionName(SCOPE, VERSIONS_COLLECTION)}\` v
       WHERE v.userId = $userId AND v.sku = $sku
         AND META(v).id NOT IN (
           SELECT RAW META(k).id FROM \`${collectionName(
             SCOPE,
             VERSIONS_COLLECTION
           )}\` k
           WHERE k.userId = $userId AND k.sku = $sku
           ORDER BY k.capturedAt DESC
           LIMIT ${SNAPSHOT_KEEP}
         )`,
      { parameters: { userId, sku } }
    );
  } catch {
    // Pruning is best-effort — snapshots are tiny.
  }
}
