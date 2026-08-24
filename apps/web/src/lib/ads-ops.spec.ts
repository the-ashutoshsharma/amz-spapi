/**
 * Advertiser profile resolution (#86).
 *
 * This account holds four Ads profiles — US, Canada, Mexico, Brazil. There is
 * no correct default among them, and the failure mode if one is picked anyway
 * is the worst kind: a confident, complete-looking answer about one marketplace
 * presented as the whole account. Nothing errors, and the number is wrong.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const listAmazonConnections = vi.fn();

vi.mock('./amazon-connections', () => ({
  listAmazonConnections: (...args: unknown[]) => listAmazonConnections(...args),
}));

/**
 * One fake client, shared by both mocks below.
 *
 * `vi.hoisted` because `vi.mock` factories are lifted above ordinary
 * declarations. Defining the class here rather than importing the real one
 * inside a factory also keeps `@farvisionllc/ad-client` a STATIC dependency of
 * this file — a dynamic `import()` makes Nx classify the library as lazy-loaded
 * and then forbids the static imports everywhere else.
 */
const { listCampaigns, updateKeywords, FakeAdsClient } = vi.hoisted(() => {
  const listCampaigns = vi.fn();
  const updateKeywords = vi.fn();
  class FakeAdsClient {
    constructor(public config: Record<string, unknown>) {}
    listCampaigns = (...args: unknown[]) => listCampaigns(this.config, ...args);
    updateKeywords = (...args: unknown[]) =>
      updateKeywords(this.config, ...args);
  }
  return { listCampaigns, updateKeywords, FakeAdsClient };
});

vi.mock('@farvisionllc/ad-client', () => ({
  AmazonAdsApiClient: FakeAdsClient,
}));

/**
 * The client factory, stubbed.
 *
 * Since #55 building a client mints an access token through the credentials
 * API, which needs a request scope and a session — neither of which exists in a
 * unit test, and neither of which this file is about. The stub keeps
 * `profileId` visible, since which advertiser profile a call is scoped to is
 * exactly what these tests assert.
 */
vi.mock('./amazon-clients', () => ({
  adsClientFor: async (connection: { profile: Record<string, unknown> }) =>
    new FakeAdsClient({
      clientId: connection.profile['client_id'],
      accessToken: 'minted',
      marketplaceId: connection.profile['marketplace_id'],
      region: connection.profile['region'],
      profileId: connection.profile['advertiser_profile_id'],
    }),
}));

/**
 * The background report runner, stubbed. What matters here is not that a state
 * machine starts, but WHICH profile and seller the job is created against —
 * resolving that after the job exists would let a queued job run for a
 * different advertiser account than the user was answered about.
 */
const { startReportJob } = vi.hoisted(() => ({ startReportJob: vi.fn() }));

vi.mock('./report-jobs-client', () => ({
  startReportJob: (...args: unknown[]) => startReportJob(...args),
}));

const { createAdsOps } = await import('./ads-ops');

function connection(
  advertiserProfileId: string | undefined,
  marketplaceId: string
) {
  return {
    profile: {
      profile_name: `ads-${marketplaceId}`,
      client_id: 'client',
      // No client_secret, refresh_token or access_token: since #55 a connection
      // carries none, and a fixture that still did would let a regression that
      // reintroduced them pass unnoticed.
      has_refresh_token: true,
      marketplace_id: marketplaceId,
      region: 'NA',
      advertiser_profile_id: advertiserProfileId,
    },
  };
}

const FOUR_PROFILES = [
  connection('967757046531288', 'ATVPDKIKX0DER'),
  connection('425541911196119', 'A2EUQ1WTGCTBG2'),
  connection('104769602540763', 'A1AM78C64UM0Y8'),
  connection('235277580219052', 'A2Q3Y263D00KWC'),
];

beforeEach(() => {
  listAmazonConnections.mockReset();
  listCampaigns.mockClear().mockResolvedValue({ items: [] });
  updateKeywords.mockClear().mockResolvedValue({ success: [], error: [] });
});

describe('with several advertiser profiles', () => {
  beforeEach(() => listAmazonConnections.mockResolvedValue(FOUR_PROFILES));

  it('refuses to guess when no profileId is given', async () => {
    const ops = createAdsOps({ userId: 'auth0|1' });

    await expect(ops.listCampaigns({})).rejects.toThrow(
      /4 advertiser profiles/
    );
    // The important half: it did NOT quietly answer for one of them.
    expect(listCampaigns).not.toHaveBeenCalled();
  });

  it('names the options so the agent can ask a real question', async () => {
    const ops = createAdsOps({ userId: 'auth0|1' });

    await expect(ops.listCampaigns({})).rejects.toThrow(/967757046531288/);
  });

  it('uses the requested profile as the API scope', async () => {
    const ops = createAdsOps({ userId: 'auth0|1' });
    await ops.listCampaigns({ profileId: '425541911196119' });

    expect(listCampaigns.mock.calls[0][0]).toMatchObject({
      profileId: '425541911196119',
      marketplaceId: 'A2EUQ1WTGCTBG2',
    });
  });

  it('rejects an unknown profileId instead of falling back', async () => {
    const ops = createAdsOps({ userId: 'auth0|1' });

    await expect(
      ops.listCampaigns({ profileId: 'not-a-profile' })
    ).rejects.toThrow(/list-ad-profiles/);
    expect(listCampaigns).not.toHaveBeenCalled();
  });

  it('lists every profile with its marketplace', async () => {
    const ops = createAdsOps({ userId: 'auth0|1' });
    const profiles = await ops.listProfiles();

    expect(profiles).toHaveLength(4);
    expect(profiles.map((p) => p.profileId)).toContain('104769602540763');
  });
});

describe('writes', () => {
  // Writes go through the SAME profile resolution as reads. The stakes are
  // higher though: a guessed profile on a read misreports a marketplace, a
  // guessed profile on a write changes bids in one.
  beforeEach(() => listAmazonConnections.mockResolvedValue(FOUR_PROFILES));

  it('refuses to guess which profile to write to', async () => {
    const ops = createAdsOps({ userId: 'auth0|1' });

    await expect(
      ops.updateKeywords({
        keywords: [{ keywordId: 'k1', bid: 0.5 }],
      })
    ).rejects.toThrow(/4 advertiser profiles/);
    expect(updateKeywords).not.toHaveBeenCalled();
  });

  it('writes through the requested profile and hands back both 207 halves', async () => {
    updateKeywords.mockResolvedValue({
      success: [{ index: 0, keywordId: 'k1' }],
      error: [{ index: 1 }],
    });
    const ops = createAdsOps({ userId: 'auth0|1' });

    const result = await ops.updateKeywords({
      profileId: '425541911196119',
      keywords: [
        { keywordId: 'k1', bid: 0.5 },
        { keywordId: 'k2', bid: 0.01 },
      ],
    });

    expect(updateKeywords.mock.calls[0][0]).toMatchObject({
      profileId: '425541911196119',
    });
    expect(updateKeywords.mock.calls[0][1]).toEqual([
      { keywordId: 'k1', bid: 0.5 },
      { keywordId: 'k2', bid: 0.01 },
    ]);
    expect(result.success).toHaveLength(1);
    expect(result.error).toHaveLength(1);
  });
});

describe('with a single advertiser profile', () => {
  it('proceeds without asking', async () => {
    // Asking when there is only one answer is its own kind of unhelpful.
    listAmazonConnections.mockResolvedValue([FOUR_PROFILES[0]]);
    const ops = createAdsOps({ userId: 'auth0|1' });

    await ops.listCampaigns({});

    expect(listCampaigns).toHaveBeenCalledOnce();
  });
});

describe('connections that cannot actually be used', () => {
  it('ignores a connection with no advertiser profile id', async () => {
    // Every Sponsored Products call sends the profile id as the API scope
    // header. A connection without one authenticates and then 401s on every
    // request, so counting it as available turns a clear "not connected" into
    // an unexplained auth failure.
    listAmazonConnections.mockResolvedValue([
      connection(undefined, 'ATVPDKIKX0DER'),
    ]);
    const ops = createAdsOps({ userId: 'auth0|1' });

    await expect(ops.listCampaigns({})).rejects.toThrow(
      /No Amazon Ads account is connected/
    );
  });

  it('does not count an unusable connection toward the ambiguity check', async () => {
    // One usable profile plus one broken one is not a choice to put to the
    // user — it is one profile.
    listAmazonConnections.mockResolvedValue([
      FOUR_PROFILES[0],
      connection(undefined, 'A2EUQ1WTGCTBG2'),
    ]);
    const ops = createAdsOps({ userId: 'auth0|1' });

    await ops.listCampaigns({});

    expect(listCampaigns).toHaveBeenCalledOnce();
  });
});

describe('queueing a performance report', () => {
  const withSeller = {
    profile: {
      ...connection('967757046531288', 'ATVPDKIKX0DER').profile,
      seller_id: 'A1SELLER',
    },
  };
  const input = {
    level: 'campaign' as const,
    startDate: '2026-08-01',
    endDate: '2026-08-07',
  };

  beforeEach(() => {
    startReportJob.mockReset().mockResolvedValue({
      started: true,
      job: { jobId: 'job-1' },
    });
    listAmazonConnections.mockResolvedValue([withSeller]);
  });

  it('files the job against the RESOLVED profile and its seller', async () => {
    const ops = createAdsOps({ userId: 'auth0|1', chatId: 'chat_1' });

    const result = await ops.startPerformanceReportJob?.(input);

    expect(result).toEqual({ started: true, jobId: 'job-1' });
    expect(startReportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'auth0|1',
        chatId: 'chat_1',
        sellerId: 'A1SELLER',
        kind: 'ads-performance',
        request: expect.objectContaining({
          profileId: '967757046531288',
          // Distinct from the profile id, and required: credentials are keyed
          // on the profile NAME, so a job carrying only the id cannot mint a
          // token and fails minutes later inside a Lambda.
          profileName: 'ads-ATVPDKIKX0DER',
          // Sent as a header on every Ads request; a placeholder is a 400.
          clientId: 'client',
          marketplaceId: 'ATVPDKIKX0DER',
          level: 'campaign',
        }),
      })
    );
  });

  it('falls back to the account seller when the ads profile carries none', async () => {
    // None of the live ads profiles have a `seller_id`, and an ads report does
    // not need one — the Amazon call is scoped by profileId and nothing is
    // filed under a seller. Requiring it here silently sent every ads report
    // back down the old in-turn path.
    listAmazonConnections.mockResolvedValue([
      connection('967757046531288', 'ATVPDKIKX0DER'),
    ]);
    const ops = createAdsOps({
      userId: 'auth0|1',
      chatId: 'chat_1',
      sellerId: 'A1ACCOUNT',
    });

    const result = await ops.startPerformanceReportJob?.(input);

    expect(result).toEqual({ started: true, jobId: 'job-1' });
    expect(startReportJob).toHaveBeenCalledWith(
      expect.objectContaining({ sellerId: 'A1ACCOUNT' })
    );
  });

  it("prefers the ads profile's own seller when it has one", async () => {
    const ops = createAdsOps({
      userId: 'auth0|1',
      chatId: 'chat_1',
      sellerId: 'A1ACCOUNT',
    });

    await ops.startPerformanceReportJob?.(input);

    expect(startReportJob).toHaveBeenCalledWith(
      expect.objectContaining({ sellerId: 'A1SELLER' })
    );
  });

  it('refuses only when no seller is known at all', async () => {
    listAmazonConnections.mockResolvedValue([
      connection('967757046531288', 'ATVPDKIKX0DER'),
    ]);
    const ops = createAdsOps({ userId: 'auth0|1', chatId: 'chat_1' });

    const result = await ops.startPerformanceReportJob?.(input);

    expect(result?.started).toBe(false);
    expect(startReportJob).not.toHaveBeenCalled();
  });

  it('refuses when there is no conversation to deliver into', async () => {
    const ops = createAdsOps({ userId: 'auth0|1' });

    const result = await ops.startPerformanceReportJob?.(input);

    // A job with no chat would run, cost money, and have nobody to tell.
    expect(result?.started).toBe(false);
    expect(startReportJob).not.toHaveBeenCalled();
  });

  it('still refuses to guess between profiles when queueing', async () => {
    listAmazonConnections.mockResolvedValue(FOUR_PROFILES);
    const ops = createAdsOps({ userId: 'auth0|1', chatId: 'chat_1' });

    await expect(ops.startPerformanceReportJob?.(input)).rejects.toThrow(
      /4 advertiser profiles/
    );
    expect(startReportJob).not.toHaveBeenCalled();
  });
});
