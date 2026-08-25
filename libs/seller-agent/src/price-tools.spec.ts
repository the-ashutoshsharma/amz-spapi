import { describe, expect, it, vi, beforeEach } from 'vitest';
import { createSellerAgent, type SellerListingWrites } from './seller-agent.js';
import type { AIProvider } from '@amz-spapi/ai-provider';

const provider = {
  languageModel: () => ({} as never),
} as unknown as AIProvider;

const mockListingWrites: SellerListingWrites = {
  previewImageUpdate: vi.fn(),
  applyImageUpdate: vi.fn(),
  revertImages: vi.fn(),
  checkListing: vi.fn(),
  checkPrice: vi.fn(),
  applyPriceUpdate: vi.fn(),
  previewPriceUpdate: vi.fn(),
  revertPrice: vi.fn(),
};

function agentWith(overrides: Record<string, unknown> = {}) {
  return createSellerAgent({
    provider,
    marketplaceId: 'ATVPDKIKX0DER',
    listingWrites: mockListingWrites,
    ...overrides,
  } as never);
}

describe('price-check tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function getPriceCheckTool() {
    const tools = (agentWith() as unknown as { tools: Record<string, never> })
      .tools;
    return tools['price-check'] as unknown as {
      description: string;
      inputSchema: {
        safeParse: (v: unknown) => { success: boolean; data?: unknown };
      };
      needsApproval?: boolean;
      execute: (input: unknown) => Promise<unknown>;
    };
  }

  it('is registered when listingWrites is provided', () => {
    const tool = getPriceCheckTool();
    expect(tool).toBeDefined();
    expect(tool.description).toContain('Analyze a current or proposed price');
  });

  it('is not approval-gated (read/check only)', () => {
    const tool = getPriceCheckTool();
    expect(tool.needsApproval).toBeUndefined();
  });

  it('validates input schema correctly', () => {
    const tool = getPriceCheckTool();

    // Valid: sku only
    expect(tool.inputSchema.safeParse({ sku: 'SKU-1' }).success).toBe(true);

    // Valid: sku + price + currency
    expect(
      tool.inputSchema.safeParse({ sku: 'SKU-1', price: 29.99, currency: 'USD' })
        .success
    ).toBe(true);

    // Invalid: empty sku
    expect(tool.inputSchema.safeParse({ sku: '' }).success).toBe(false);

    // Invalid: negative price
    expect(tool.inputSchema.safeParse({ sku: 'SKU-1', price: -5 }).success).toBe(
      false
    );
  });

  it('delegates execution to listingWrites.checkPrice', async () => {
    const tool = getPriceCheckTool();
    vi.mocked(mockListingWrites.checkPrice).mockResolvedValueOnce({
      sku: 'SKU-1',
      proposedPrice: 25.0,
      verdict: 'PASS',
    });

    const result = await tool.execute({ sku: 'SKU-1', price: 25.0 });

    expect(mockListingWrites.checkPrice).toHaveBeenCalledWith({
      sku: 'SKU-1',
      price: 25.0,
    });
    expect(result).toEqual({
      sku: 'SKU-1',
      proposedPrice: 25.0,
      verdict: 'PASS',
    });
  });
});

describe('set-price tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function getSetPriceTool() {
    const tools = (agentWith() as unknown as { tools: Record<string, never> })
      .tools;
    return tools['set-price'] as unknown as {
      description: string;
      inputSchema: {
        safeParse: (v: unknown) => { success: boolean; data?: unknown };
      };
      needsApproval?: boolean;
      execute: (input: unknown) => Promise<unknown>;
    };
  }

  it('is registered when listingWrites is provided', () => {
    const tool = getSetPriceTool();
    expect(tool).toBeDefined();
    expect(tool.description).toContain('WRITE a new price for a SKU');
  });

  it('is approval-gated (needsApproval: true)', () => {
    const tool = getSetPriceTool();
    expect(tool.needsApproval).toBe(true);
  });

  it('validates input schema requiring SKU and positive price', () => {
    const tool = getSetPriceTool();

    // Valid: sku and positive price
    expect(
      tool.inputSchema.safeParse({ sku: 'SKU-1', price: 19.99, currency: 'USD' })
        .success
    ).toBe(true);

    // Invalid: missing price
    expect(tool.inputSchema.safeParse({ sku: 'SKU-1' }).success).toBe(false);

    // Invalid: negative or zero price
    expect(tool.inputSchema.safeParse({ sku: 'SKU-1', price: 0 }).success).toBe(
      false
    );
    expect(tool.inputSchema.safeParse({ sku: 'SKU-1', price: -10 }).success).toBe(
      false
    );
  });

  it('delegates execution to listingWrites.applyPriceUpdate', async () => {
    const tool = getSetPriceTool();
    vi.mocked(mockListingWrites.applyPriceUpdate).mockResolvedValueOnce({
      status: 'ACCEPTED',
      submissionId: 'sub_999',
      sku: 'SKU-1',
      newPrice: 22.5,
    });

    const result = await tool.execute({ sku: 'SKU-1', price: 22.5 });

    expect(mockListingWrites.applyPriceUpdate).toHaveBeenCalledWith({
      sku: 'SKU-1',
      price: 22.5,
    });
    expect(result).toEqual({
      status: 'ACCEPTED',
      submissionId: 'sub_999',
      sku: 'SKU-1',
      newPrice: 22.5,
    });
  });
});
