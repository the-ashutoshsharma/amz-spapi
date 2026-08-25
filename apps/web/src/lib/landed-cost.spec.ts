import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  calculateContributionMargin,
  populateProductCogsFromPurchases,
  resolveLandedCost,
} from './landed-cost';
import type { StoredDocument, StoredPurchaseOrder } from '@amz-spapi/sp-cache';
import type { Product, ProductListing } from '@farvisionllc/models';

const mockFindListingBySku = vi.fn();
const mockGetProduct = vi.fn();
const mockUpsertProduct = vi.fn();
const mockListPurchaseOrders = vi.fn();
const mockListDocuments = vi.fn();

vi.mock('./product-listings', () => ({
  findListingBySku: (params: unknown) => mockFindListingBySku(params),
}));

vi.mock('./products', () => ({
  getProduct: (params: unknown) => mockGetProduct(params),
  upsertProduct: (product: unknown) => mockUpsertProduct(product),
}));

vi.mock('@amz-spapi/sp-cache', () => ({
  listPurchaseOrders: (userId: string) => mockListPurchaseOrders(userId),
  listDocuments: (userId: string) => mockListDocuments(userId),
}));

describe('calculateContributionMargin', () => {
  it('computes contribution margin and percentage correctly when profitable', () => {
    const result = calculateContributionMargin({
      price: 30,
      fees: 7.5,
      landedCost: 10,
    });

    expect(result.contributionMargin).toBe(12.5);
    expect(result.contributionMarginPercent).toBe(41.67);
    expect(result.floorSatisfied).toBe(true);
    expect(result.breachAmount).toBeUndefined();
  });

  it('detects a margin floor breach when contribution margin is negative', () => {
    const result = calculateContributionMargin({
      price: 15,
      fees: 6,
      landedCost: 10,
    });

    expect(result.contributionMargin).toBe(-1);
    expect(result.contributionMarginPercent).toBe(-6.67);
    expect(result.floorSatisfied).toBe(false);
    expect(result.breachAmount).toBe(1);
  });

  it('respects a custom floorThresholdPercent', () => {
    const result = calculateContributionMargin({
      price: 20,
      fees: 5,
      landedCost: 14,
      floorThresholdPercent: 10, // requires 10% margin
    });

    // Margin is $1 on $20 = 5%, which is < 10%
    expect(result.contributionMargin).toBe(1);
    expect(result.contributionMarginPercent).toBe(5);
    expect(result.floorSatisfied).toBe(false);
  });
});

describe('resolveLandedCost', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves unit cost from Product sourcing cogs when present', async () => {
    mockFindListingBySku.mockResolvedValueOnce({
      listingId: 'l1',
      productId: 'prod1',
      external: { sku: 'SKU-COFFEE-1' },
    } as ProductListing);

    mockGetProduct.mockResolvedValueOnce({
      productId: 'prod1',
      userId: 'user1',
      title: 'French Press',
      sourcing: {
        cogs: {
          unitCost: 8.5,
          currency: 'USD',
        },
      },
      updatedAt: 1700000000,
    } as Product);

    const cost = await resolveLandedCost({
      userId: 'user1',
      sku: 'SKU-COFFEE-1',
    });

    expect(cost).toEqual({
      unitCost: 8.5,
      currency: 'USD',
      source: 'product_cogs',
      reference: 'Product prod1',
      capturedAt: 1700000000,
    });
    expect(mockListPurchaseOrders).not.toHaveBeenCalled();
  });

  it('falls back to latest Purchase Order line when Product cogs is absent', async () => {
    mockFindListingBySku.mockResolvedValueOnce(null);

    const mockPos: StoredPurchaseOrder[] = [
      {
        key: 'user1::PO-2026-0001',
        userId: 'user1',
        storedAt: 1000,
        updatedAt: 1000,
        renders: [],
        order: {
          poNumber: 'PO-2026-0001',
          issueDate: '2026-01-01',
          status: 'open',
          vendorId: 'v1',
          currency: 'USD',
          revision: 1,
          lines: [
            {
              sku: 'SKU-COFFEE-1',
              description: 'Old Order',
              quantity: 100,
              unitPrice: 9.0,
            },
          ],
        },
      },
      {
        key: 'user1::PO-2026-0002',
        userId: 'user1',
        storedAt: 2000,
        updatedAt: 2000,
        renders: [],
        order: {
          poNumber: 'PO-2026-0002',
          issueDate: '2026-02-01',
          status: 'open',
          vendorId: 'v1',
          currency: 'USD',
          revision: 1,
          freightAmount: 100,
          otherFees: [{ description: 'Customs fee', amount: 50 }],
          lines: [
            {
              sku: 'SKU-COFFEE-1',
              description: 'Recent Order',
              quantity: 150,
              unitPrice: 7.0,
            },
          ],
        },
      },
    ];

    mockListPurchaseOrders.mockResolvedValueOnce(mockPos);

    const cost = await resolveLandedCost({
      userId: 'user1',
      sku: 'SKU-COFFEE-1',
    });

    // Base unitPrice 7.00 + (100 + 50 freight/fees) / 150 units = 7.00 + 1.00 = 8.00
    expect(cost).toEqual({
      unitCost: 8,
      currency: 'USD',
      source: 'purchase_order',
      reference: 'PO-2026-0002',
      capturedAt: 2000,
    });
  });

  it('falls back to Commercial Invoice extraction when POs are missing', async () => {
    mockFindListingBySku.mockResolvedValueOnce(null);
    mockListPurchaseOrders.mockResolvedValueOnce([]);

    const mockDocs: StoredDocument[] = [
      {
        documentId: 'doc-inv-1',
        userId: 'user1',
        role: 'commercial-invoice',
        fileName: 'Invoice_2026_03.pdf',
        assetId: 'asset1',
        storedAt: 3000,
        extracted: {
          currency: 'USD',
          lines: [
            {
              supplierRef: 'SKU-COFFEE-1',
              description: 'French Press',
              quantity: 200,
              amount: 1500, // 1500 / 200 = 7.50
            },
          ],
        },
      } as unknown as StoredDocument,
    ];

    mockListDocuments.mockResolvedValueOnce(mockDocs);

    const cost = await resolveLandedCost({
      userId: 'user1',
      sku: 'SKU-COFFEE-1',
    });

    expect(cost).toEqual({
      unitCost: 7.5,
      currency: 'USD',
      source: 'commercial_invoice',
      reference: 'Invoice_2026_03.pdf',
      capturedAt: 3000,
    });
  });

  it('returns null when no cost basis exists anywhere', async () => {
    mockFindListingBySku.mockResolvedValueOnce(null);
    mockListPurchaseOrders.mockResolvedValueOnce([]);
    mockListDocuments.mockResolvedValueOnce([]);

    const cost = await resolveLandedCost({
      userId: 'user1',
      sku: 'UNKNOWN-SKU',
    });

    expect(cost).toBeNull();
  });
});

describe('populateProductCogsFromPurchases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('populates Product sourcing cogs from PO when unset', async () => {
    mockFindListingBySku.mockResolvedValue({
      listingId: 'l1',
      productId: 'prod1',
      external: { sku: 'SKU-COFFEE-1' },
    } as ProductListing);

    const productWithoutCogs: Product = {
      productId: 'prod1',
      userId: 'user1',
      title: 'French Press',
      createdAt: 1000,
      updatedAt: 1000,
      status: 'active',
    };

    mockGetProduct.mockResolvedValue(productWithoutCogs);

    mockListPurchaseOrders.mockResolvedValueOnce([
      {
        key: 'user1::PO-2026-0001',
        userId: 'user1',
        storedAt: 1000,
        updatedAt: 1000,
        renders: [],
        order: {
          poNumber: 'PO-2026-0001',
          issueDate: '2026-01-01',
          status: 'open',
          vendorId: 'v1',
          currency: 'USD',
          revision: 1,
          lines: [
            {
              sku: 'SKU-COFFEE-1',
              description: 'Order',
              quantity: 100,
              unitPrice: 6.5,
            },
          ],
        },
      },
    ]);

    const result = await populateProductCogsFromPurchases({
      userId: 'user1',
      sku: 'SKU-COFFEE-1',
    });

    expect(result?.unitCost).toBe(6.5);
    expect(mockUpsertProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'prod1',
        sourcing: {
          cogs: {
            unitCost: 6.5,
            currency: 'USD',
          },
        },
      })
    );
  });

  it('populates Product sourcing cogs from PO when product COGS unitCost is 0 or negative', async () => {
    mockFindListingBySku.mockResolvedValue({
      listingId: 'l1',
      productId: 'prod1',
      external: { sku: 'SKU-COFFEE-1' },
    } as ProductListing);

    const productWithZeroCogs: Product = {
      productId: 'prod1',
      userId: 'user1',
      title: 'French Press',
      createdAt: 1000,
      updatedAt: 1000,
      status: 'active',
      sourcing: {
        cogs: {
          unitCost: 0,
          currency: 'USD',
        },
      },
    };

    mockGetProduct.mockResolvedValue(productWithZeroCogs);

    mockListPurchaseOrders.mockResolvedValueOnce([
      {
        key: 'user1::PO-2026-0001',
        userId: 'user1',
        storedAt: 1000,
        updatedAt: 1000,
        renders: [],
        order: {
          poNumber: 'PO-2026-0001',
          issueDate: '2026-01-01',
          status: 'open',
          vendorId: 'v1',
          currency: 'USD',
          revision: 1,
          lines: [
            {
              sku: 'SKU-COFFEE-1',
              description: 'Order',
              quantity: 100,
              unitPrice: 7.25,
            },
          ],
        },
      },
    ]);

    const result = await populateProductCogsFromPurchases({
      userId: 'user1',
      sku: 'SKU-COFFEE-1',
    });

    expect(result?.unitCost).toBe(7.25);
    expect(mockUpsertProduct).toHaveBeenCalledWith(
      expect.objectContaining({
        productId: 'prod1',
        sourcing: {
          cogs: {
            unitCost: 7.25,
            currency: 'USD',
          },
        },
      })
    );
  });
});
