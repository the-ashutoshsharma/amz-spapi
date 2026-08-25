import {
  listDocuments,
  listPurchaseOrders,
  type StoredDocument,
  type StoredPurchaseOrder,
} from '@amz-spapi/sp-cache';
import { purchaseOrderTotals } from '@farvisionllc/models';
import { findListingBySku } from './product-listings';
import { getProduct, upsertProduct } from './products';

export type LandedCostBasis = {
  unitCost: number;
  currency: string;
  source: 'product_cogs' | 'purchase_order' | 'commercial_invoice';
  reference?: string;
  capturedAt?: number;
};

export type ContributionMarginResult = {
  price: number;
  fees: number;
  landedCost: number;
  contributionMargin: number;
  contributionMarginPercent: number;
  floorSatisfied: boolean;
  floorThresholdPercent: number;
  breachAmount?: number;
};

/**
 * Resolve per-SKU landed cost for a seller:
 * 1. Product sourcing COGS (Product.sourcing.cogs.unitCost)
 * 2. Fallback: most recent non-cancelled Purchase Order line for this SKU (+ allocated freight/fees)
 * 3. Fallback: most recent Commercial Invoice line matching this SKU (line.amount / line.quantity)
 */
export async function resolveLandedCost(params: {
  userId: string;
  sku: string;
  marketplaceId?: string;
}): Promise<LandedCostBasis | null> {
  const marketplaceId = params.marketplaceId ?? 'ATVPDKIKX0DER';

  // 1. Check Product record via listing lookup
  try {
    const listing = await findListingBySku({
      userId: params.userId,
      marketplaceId,
      sku: params.sku,
    });
    if (listing?.productId) {
      const product = await getProduct({
        userId: params.userId,
        productId: listing.productId,
      });
      if (
        product?.sourcing?.cogs?.unitCost !== undefined &&
        product.sourcing.cogs.unitCost > 0
      ) {
        return {
          unitCost: product.sourcing.cogs.unitCost,
          currency: product.sourcing.cogs.currency ?? 'USD',
          source: 'product_cogs',
          reference: `Product ${product.productId}`,
          capturedAt: product.updatedAt,
        };
      }
    }
  } catch {
    // Database lookup failure falls through to PO/invoice scan
  }

  // 2. Scan Purchase Orders
  try {
    const orders = await listPurchaseOrders(params.userId);
    const validOrders = orders
      .filter((po) => po.order.status !== 'cancelled')
      .sort((a, b) => b.storedAt - a.storedAt);

    for (const po of validOrders) {
      const line = po.order.lines.find((l) => l.sku === params.sku);
      if (line && typeof line.unitPrice === 'number' && line.unitPrice > 0) {
        const totals = purchaseOrderTotals(po.order);
        const extraPerUnit =
          totals.totalUnits > 0
            ? (totals.freight + totals.fees) / totals.totalUnits
            : 0;
        const unitCost =
          Math.round((line.unitPrice + extraPerUnit) * 100) / 100;
        return {
          unitCost,
          currency: po.order.currency || 'USD',
          source: 'purchase_order',
          reference: po.order.poNumber,
          capturedAt: po.storedAt,
        };
      }
    }
  } catch {
    // PO lookup failure falls through to invoice scan
  }

  // 3. Scan Commercial Invoices
  try {
    const documents = await listDocuments(params.userId);
    const invoices = documents
      .filter((d) => d.role === 'commercial-invoice')
      .sort((a, b) => b.storedAt - a.storedAt);

    for (const doc of invoices) {
      const lines = doc.extracted.lines ?? [];
      const line = lines.find(
        (l) =>
          l.supplierRef === params.sku ||
          (l.description && l.description.includes(params.sku))
      );
      if (
        line &&
        typeof line.amount === 'number' &&
        typeof line.quantity === 'number' &&
        line.quantity > 0
      ) {
        const unitCost = Math.round((line.amount / line.quantity) * 100) / 100;
        return {
          unitCost,
          currency: doc.extracted.currency ?? 'USD',
          source: 'commercial_invoice',
          reference: doc.fileName ?? doc.documentId,
          capturedAt: doc.storedAt,
        };
      }
    }
  } catch {
    // Invoice lookup failure
  }

  return null;
}

/**
 * Calculate contribution margin and evaluate against margin floor.
 */
export function calculateContributionMargin(params: {
  price: number;
  fees: number;
  landedCost: number;
  floorThresholdPercent?: number;
}): ContributionMarginResult {
  const { price, fees, landedCost } = params;
  const floorThresholdPercent = params.floorThresholdPercent ?? 0;

  const contributionMargin = Math.round((price - fees - landedCost) * 100) / 100;
  const contributionMarginPercent =
    price > 0
      ? Math.round((contributionMargin / price) * 10000) / 100
      : 0;

  const floorSatisfied =
    contributionMarginPercent >= floorThresholdPercent && contributionMargin >= 0;

  return {
    price,
    fees,
    landedCost,
    contributionMargin,
    contributionMarginPercent,
    floorSatisfied,
    floorThresholdPercent,
    breachAmount: floorSatisfied ? undefined : Math.abs(contributionMargin),
  };
}

/**
 * Populate Product.sourcing.cogs from historical POs/invoices if currently unset.
 */
export async function populateProductCogsFromPurchases(params: {
  userId: string;
  sku: string;
  marketplaceId?: string;
}): Promise<LandedCostBasis | null> {
  const marketplaceId = params.marketplaceId ?? 'ATVPDKIKX0DER';
  const listing = await findListingBySku({
    userId: params.userId,
    marketplaceId,
    sku: params.sku,
  });
  if (!listing?.productId) return null;

  const product = await getProduct({
    userId: params.userId,
    productId: listing.productId,
  });
  if (!product) return null;

  if (
    product.sourcing?.cogs?.unitCost !== undefined &&
    product.sourcing.cogs.unitCost > 0
  ) {
    return {
      unitCost: product.sourcing.cogs.unitCost,
      currency: product.sourcing.cogs.currency ?? 'USD',
      source: 'product_cogs',
      reference: `Product ${product.productId}`,
      capturedAt: product.updatedAt,
    };
  }

  const derived = await resolveLandedCost({
    userId: params.userId,
    sku: params.sku,
    marketplaceId,
  });

  if (derived && derived.source !== 'product_cogs') {
    await upsertProduct({
      ...product,
      sourcing: {
        ...product.sourcing,
        cogs: {
          ...product.sourcing?.cogs,
          unitCost: derived.unitCost,
          currency: derived.currency,
        },
      },
    });
  }

  return derived;
}
