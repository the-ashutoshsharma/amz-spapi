import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  buildPricePatches,
  createListingWrites,
  extractCurrentPrice,
  type ListingWritesDeps,
} from './listing-writes';
import type { SpApiClient } from '@farvisionllc/sp-client';

const mockGetListingsItem = vi.fn();
const mockPatchListingsItem = vi.fn();
const mockGetFeaturedOfferExpectedPrice = vi.fn();
const mockGetMyFeesEstimateForSKU = vi.fn();

const mockUpsertDocument = vi.fn();
const mockGetDocument = vi.fn();
const mockExecuteQuery = vi.fn();

const mockResolveLandedCost = vi.fn();

vi.mock('@amz-spapi/couchbase-utils', () => ({
  collectionName: (scope: string, collection: string) => `${scope}.${collection}`,
  upsertDocument: (...args: unknown[]) => mockUpsertDocument(...args),
  getDocument: (...args: unknown[]) => mockGetDocument(...args),
  executeQuery: (...args: unknown[]) => mockExecuteQuery(...args),
}));

vi.mock('./landed-cost', () => ({
  resolveLandedCost: (params: unknown) => mockResolveLandedCost(params),
  calculateContributionMargin: vi.fn(
    (params: { price: number; fees: number; landedCost: number }) => {
      const margin = params.price - params.fees - params.landedCost;
      const pct = params.price > 0 ? (margin / params.price) * 100 : 0;
      return {
        price: params.price,
        fees: params.fees,
        landedCost: params.landedCost,
        contributionMargin: Math.round(margin * 100) / 100,
        contributionMarginPercent: Math.round(pct * 100) / 100,
        floorSatisfied: margin >= 0,
        floorThresholdPercent: 0,
        breachAmount: margin < 0 ? Math.abs(margin) : undefined,
      };
    }
  ),
}));

describe('extractCurrentPrice', () => {
  it('extracts price from offers first', () => {
    const offers = [{ price: { amount: '29.99', currencyCode: 'USD' } }];
    const attributes = {
      purchasable_offer: [
        {
          currency: 'USD',
          our_price: [{ schedule: [{ value_with_tax: 34.99 }] }],
        },
      ],
    };
    const result = extractCurrentPrice(attributes, offers);
    expect(result).toEqual({ amount: 29.99, currency: 'USD' });
  });

  it('falls back to purchasable_offer attribute when offers is empty', () => {
    const attributes = {
      purchasable_offer: [
        {
          currency: 'USD',
          our_price: [{ schedule: [{ value_with_tax: 34.99 }] }],
        },
      ],
    };
    const result = extractCurrentPrice(attributes, []);
    expect(result).toEqual({ amount: 34.99, currency: 'USD' });
  });
});

describe('buildPricePatches', () => {
  it('constructs replace patch on /attributes/purchasable_offer', () => {
    const patches = buildPricePatches({
      marketplaceId: 'ATVPDKIKX0DER',
      price: 25.5,
      currency: 'USD',
    });

    expect(patches).toEqual([
      {
        op: 'replace',
        path: '/attributes/purchasable_offer',
        value: [
          {
            marketplace_id: 'ATVPDKIKX0DER',
            currency: 'USD',
            our_price: [
              {
                schedule: [
                  {
                    value_with_tax: 25.5,
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });
});

describe('createListingWrites - pricing operations', () => {
  let deps: ListingWritesDeps;

  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteQuery.mockResolvedValue({ rows: [] });

    const mockSpClient = {
      getListingsItem: mockGetListingsItem,
      patchListingsItem: mockPatchListingsItem,
      getFeaturedOfferExpectedPrice: mockGetFeaturedOfferExpectedPrice,
      getMyFeesEstimateForSKU: mockGetMyFeesEstimateForSKU,
    } as unknown as SpApiClient;

    deps = {
      userId: 'user_123',
      sellerId: 'SELLER_123',
      marketplaceId: 'ATVPDKIKX0DER',
      spClient: mockSpClient,
    };
  });

  describe('checkPrice', () => {
    it('returns full pricing and margin breakdown when price is healthy', async () => {
      mockGetListingsItem.mockResolvedValueOnce({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {},
        offers: [{ price: { amount: '30.00', currencyCode: 'USD' } }],
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValueOnce({
        status: 'VALID_FOEP',
        expectedPrice: 29.5,
        currency: 'USD',
        competingPrice: 29.99,
      });

      mockGetMyFeesEstimateForSKU.mockResolvedValueOnce({
        referralFee: 4.5,
        fulfillmentFee: 3.5,
        totalFees: 8.0,
        currency: 'USD',
      });

      mockResolveLandedCost.mockResolvedValueOnce({
        unitCost: 10.0,
        currency: 'USD',
        source: 'purchase_order',
        reference: 'PO-2026-0001',
      });

      const writes = createListingWrites(deps);
      const result = await writes.checkPrice({
        sku: 'SKU-COFFEE-1',
        price: 28.0,
      });

      expect(result.sku).toBe('SKU-COFFEE-1');
      expect(result.currentPrice).toBe(30.0);
      expect(result.proposedPrice).toBe(28.0);
      expect(result.changePercent).toBe(-6.67);
      expect(result.landedCost?.unitCost).toBe(10.0);
      expect(result.fees.totalFees).toBe(8.0);
      expect(result.margin.contributionMargin).toBe(10.0); // 28 - 8 - 10 = 10
      expect(result.margin.floorSatisfied).toBe(true);
      expect(result.verdict).toBe('PASS');
    });

    it('identifies margin floor breach and includes clear warning', async () => {
      mockGetListingsItem.mockResolvedValueOnce({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {},
        offers: [{ price: { amount: '20.00', currencyCode: 'USD' } }],
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValueOnce({
        status: 'VALID_FOEP',
      });

      mockGetMyFeesEstimateForSKU.mockResolvedValueOnce({
        referralFee: 3.0,
        fulfillmentFee: 4.0,
        totalFees: 7.0,
        currency: 'USD',
      });

      mockResolveLandedCost.mockResolvedValueOnce({
        unitCost: 15.0,
        currency: 'USD',
        source: 'purchase_order',
        reference: 'PO-2026-0001',
      });

      const writes = createListingWrites(deps);
      const result = await writes.checkPrice({
        sku: 'SKU-COFFEE-1',
        price: 18.0, // 18 - 7 - 15 = -4.00 breach!
      });

      expect(result.verdict).toBe('MARGIN_FLOOR_BREACH');
      expect(result.margin.floorSatisfied).toBe(false);
      expect(result.margin.contributionMargin).toBe(-4.0);
      expect(result.warnings.some((w) => w.includes('breaches the margin floor'))).toBe(true);
    });

    it('surfaces OFFER_NOT_ELIGIBLE as a prominent warning without breaking', async () => {
      mockGetListingsItem.mockResolvedValueOnce({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {},
        offers: [{ price: { amount: '25.00', currencyCode: 'USD' } }],
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValueOnce({
        status: 'OFFER_NOT_ELIGIBLE',
      });

      mockGetMyFeesEstimateForSKU.mockResolvedValueOnce({
        referralFee: 3.75,
        fulfillmentFee: 3.25,
        totalFees: 7.0,
        currency: 'USD',
      });

      mockResolveLandedCost.mockResolvedValueOnce({
        unitCost: 8.0,
        currency: 'USD',
        source: 'product_cogs',
      });

      const writes = createListingWrites(deps);
      const result = await writes.checkPrice({
        sku: 'SKU-COFFEE-1',
        price: 24.0,
      });

      expect(result.verdict).toBe('PASS');
      expect(result.warnings.some((w) => w.includes('NOT ELIGIBLE'))).toBe(true);
    });

    it('marks MISSING_COST_BASIS when landed cost currency differs from listing currency', async () => {
      mockGetListingsItem.mockResolvedValueOnce({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {},
        offers: [{ price: { amount: '25.00', currencyCode: 'USD' } }],
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValueOnce({
        status: 'VALID_FOEP',
      });

      mockGetMyFeesEstimateForSKU.mockResolvedValueOnce({
        referralFee: 3.75,
        fulfillmentFee: 3.25,
        totalFees: 7.0,
        currency: 'USD',
      });

      mockResolveLandedCost.mockResolvedValueOnce({
        unitCost: 50.0,
        currency: 'CNY', // Mismatched currency!
        source: 'purchase_order',
      });

      const writes = createListingWrites(deps);
      const result = await writes.checkPrice({
        sku: 'SKU-COFFEE-1',
        price: 24.0,
      });

      expect(result.verdict).toBe('MISSING_COST_BASIS');
      expect(
        result.warnings.some((w) =>
          w.includes('does not match listing currency USD')
        )
      ).toBe(true);
    });

    it('fails safely by throwing when fee estimation fails', async () => {
      mockGetListingsItem.mockResolvedValueOnce({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {},
        offers: [{ price: { amount: '25.00', currencyCode: 'USD' } }],
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValueOnce({
        status: 'VALID_FOEP',
      });

      mockGetMyFeesEstimateForSKU.mockRejectedValueOnce(
        new Error('Product Fees API 500 error')
      );

      mockResolveLandedCost.mockResolvedValueOnce({
        unitCost: 8.0,
        currency: 'USD',
        source: 'product_cogs',
      });

      const writes = createListingWrites(deps);
      await expect(
        writes.checkPrice({
          sku: 'SKU-COFFEE-1',
          price: 24.0,
        })
      ).rejects.toThrow('Product Fees API 500 error');
    });
  });

  describe('applyPriceUpdate', () => {
    it('refuses price changes when landed cost is missing (MISSING_COST_BASIS)', async () => {
      mockGetListingsItem.mockResolvedValue({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {},
        offers: [{ price: { amount: '25.00', currencyCode: 'USD' } }],
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValue({
        status: 'VALID_FOEP',
      });

      mockGetMyFeesEstimateForSKU.mockResolvedValue({
        referralFee: 3.75,
        fulfillmentFee: 3.25,
        totalFees: 7.0,
        currency: 'USD',
      });

      mockResolveLandedCost.mockResolvedValue(null); // No landed cost

      const writes = createListingWrites(deps);

      await expect(
        writes.applyPriceUpdate({
          sku: 'SKU-COFFEE-1',
          price: 24.0,
        })
      ).rejects.toThrow(
        /Refusing price change for SKU SKU-COFFEE-1: no verified cost basis found/
      );

      expect(mockPatchListingsItem).not.toHaveBeenCalled();
    });

    it('refuses price changes when current listing price is unavailable (cannot bypass ±20% cap)', async () => {
      mockGetListingsItem.mockResolvedValue({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {},
        offers: [], // No current price
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValue({
        status: 'VALID_FOEP',
      });

      mockGetMyFeesEstimateForSKU.mockResolvedValue({
        referralFee: 3.75,
        fulfillmentFee: 3.25,
        totalFees: 7.0,
        currency: 'USD',
      });

      mockResolveLandedCost.mockResolvedValue({
        unitCost: 8.0,
        currency: 'USD',
        source: 'product_cogs',
      });

      const writes = createListingWrites(deps);

      await expect(
        writes.applyPriceUpdate({
          sku: 'SKU-COFFEE-1',
          price: 24.0,
        })
      ).rejects.toThrow(
        /current listing price could not be determined to verify the ±20% single-call safety threshold/
      );

      expect(mockPatchListingsItem).not.toHaveBeenCalled();
    });

    it('refuses price changes that breach the margin floor with explicit error details', async () => {
      mockGetListingsItem.mockResolvedValue({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {},
        offers: [{ price: { amount: '20.00', currencyCode: 'USD' } }],
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValue({
        status: 'VALID_FOEP',
      });

      mockGetMyFeesEstimateForSKU.mockResolvedValue({
        referralFee: 3.0,
        fulfillmentFee: 4.0,
        totalFees: 7.0,
        currency: 'USD',
      });

      mockResolveLandedCost.mockResolvedValue({
        unitCost: 16.0,
        currency: 'USD',
        source: 'purchase_order',
      });

      const writes = createListingWrites(deps);

      // 18 - 7 - 16 = -5.00 breach!
      await expect(
        writes.applyPriceUpdate({
          sku: 'SKU-COFFEE-1',
          price: 18.0,
        })
      ).rejects.toThrow(/Refusing price change for SKU SKU-COFFEE-1.*breaches the margin floor/);

      expect(mockPatchListingsItem).not.toHaveBeenCalled();
    });

    it('refuses price changes exceeding the ±20% safety threshold', async () => {
      mockGetListingsItem.mockResolvedValue({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {},
        offers: [{ price: { amount: '50.00', currencyCode: 'USD' } }],
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValue({
        status: 'VALID_FOEP',
      });

      mockGetMyFeesEstimateForSKU.mockResolvedValue({
        referralFee: 4.0,
        fulfillmentFee: 3.0,
        totalFees: 7.0,
        currency: 'USD',
      });

      mockResolveLandedCost.mockResolvedValue({
        unitCost: 10.0,
        currency: 'USD',
        source: 'product_cogs',
      });

      const writes = createListingWrites(deps);

      // 50 -> 25 is -50% change (exceeds default 20%)
      await expect(
        writes.applyPriceUpdate({
          sku: 'SKU-COFFEE-1',
          price: 25.0,
        })
      ).rejects.toThrow(/exceeds the ±20% single-call safety threshold/);

      expect(mockPatchListingsItem).not.toHaveBeenCalled();
    });

    it('snapshots attributes and submits patch to Amazon when price is valid and approved', async () => {
      mockGetListingsItem.mockResolvedValue({
        summaries: [{ productType: 'COFFEE_MAKER' }],
        attributes: {
          title: [{ value: 'French Press' }],
          purchasable_offer: [
            {
              currency: 'USD',
              our_price: [{ schedule: [{ value_with_tax: 30.0 }] }],
            },
          ],
        },
        offers: [{ price: { amount: '30.00', currencyCode: 'USD' } }],
        issues: [],
      });

      mockGetFeaturedOfferExpectedPrice.mockResolvedValue({
        status: 'VALID_FOEP',
      });

      mockGetMyFeesEstimateForSKU.mockResolvedValue({
        referralFee: 4.0,
        fulfillmentFee: 3.0,
        totalFees: 7.0,
        currency: 'USD',
      });

      mockResolveLandedCost.mockResolvedValue({
        unitCost: 10.0,
        currency: 'USD',
        source: 'product_cogs',
      });

      mockPatchListingsItem.mockResolvedValue({
        status: 'ACCEPTED',
        submissionId: 'sub_12345',
        issues: [],
      });

      const writes = createListingWrites(deps);
      const result = await writes.applyPriceUpdate({
        sku: 'SKU-COFFEE-1',
        price: 28.5,
      });

      expect(result.status).toBe('ACCEPTED');
      expect(result.submissionId).toBe('sub_12345');
      expect(result.sku).toBe('SKU-COFFEE-1');
      expect(result.previousPrice).toBe(30.0);
      expect(result.newPrice).toBe(28.5);
      expect(result.snapshotId).toMatch(/^lver_/);

      // Verify snapshot was saved
      expect(mockUpsertDocument).toHaveBeenCalledWith(
        'catalog',
        'listing_versions',
        expect.stringContaining('listing-ver::'),
        expect.objectContaining({
          sku: 'SKU-COFFEE-1',
          productType: 'COFFEE_MAKER',
        })
      );

      // Verify patchListingsItem was called with /attributes/purchasable_offer
      expect(mockPatchListingsItem).toHaveBeenCalledWith(
        expect.objectContaining({
          sku: 'SKU-COFFEE-1',
          sellerId: 'SELLER_123',
          productType: 'COFFEE_MAKER',
          patches: expect.arrayContaining([
            expect.objectContaining({
              op: 'replace',
              path: '/attributes/purchasable_offer',
            }),
          ]),
        })
      );
    });

    it('enforces SKU allowlist when configured', async () => {
      const restrictedDeps = {
        ...deps,
        skuAllowlist: ['TEST-SKU-ALLOWED'],
      };

      const writes = createListingWrites(restrictedDeps);

      await expect(
        writes.applyPriceUpdate({
          sku: 'FORBIDDEN-SKU',
          price: 25.0,
        })
      ).rejects.toThrow(/SKU FORBIDDEN-SKU is not in LISTING_WRITE_SKU_ALLOWLIST/);
    });
  });

  describe('revertPrice', () => {
    it('restores previous purchasable_offer from stored snapshot', async () => {
      mockGetDocument.mockResolvedValueOnce({
        snapshotId: 'snap_1',
        userId: 'user_123',
        sku: 'SKU-COFFEE-1',
        productType: 'COFFEE_MAKER',
        capturedAt: 1000,
        attributes: {
          purchasable_offer: [
            {
              currency: 'USD',
              our_price: [{ schedule: [{ value_with_tax: 32.0 }] }],
            },
          ],
        },
      });

      mockPatchListingsItem.mockResolvedValueOnce({
        status: 'ACCEPTED',
        submissionId: 'sub_revert_123',
        issues: [],
      });

      const writes = createListingWrites(deps);
      const result = await writes.revertPrice({
        sku: 'SKU-COFFEE-1',
        snapshotId: 'snap_1',
      });

      expect(result.status).toBe('ACCEPTED');
      expect(result.submissionId).toBe('sub_revert_123');
      expect(mockPatchListingsItem).toHaveBeenCalledWith(
        expect.objectContaining({
          sku: 'SKU-COFFEE-1',
          patches: [
            {
              op: 'replace',
              path: '/attributes/purchasable_offer',
              value: [
                {
                  currency: 'USD',
                  our_price: [{ schedule: [{ value_with_tax: 32.0 }] }],
                },
              ],
            },
          ],
        })
      );
    });
  });
});
