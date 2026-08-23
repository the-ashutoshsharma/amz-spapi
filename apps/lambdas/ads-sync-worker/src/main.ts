import { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import { AmazonAdsApiClient } from '@farvisionllc/ad-client';
import { executeQuery } from '@amz-spapi/couchbase-utils';
import {
  collectAdsReport,
  queryHarvestRows,
  reconcileDueNegatives,
  requestAdsReport,
  type ReportKind,
} from '@amz-spapi/sp-cache';
import {
  mintSellerAccessToken,
  useSecretsManagerConnection,
} from '@amz-spapi/aws-secrets';

/**
 * One step of the Amazon Ads report sync (#145).
 *
 * Three steps in one deployable, chosen by a discriminator on the event, driven
 * by a Step Functions state machine rather than a queue:
 *
 *   plan     → the windows worth fetching
 *   request  → ask Amazon to build one report
 *   collect  → poll once; ingest if ready
 *
 * ## Why a state machine and not the SQS FIFO queue next door
 *
 * The SP sync's queue is not a buffer, it is a rate-pacing mechanism: the seller
 * id is the message group, so one seller's calls serialise while other sellers
 * proceed. That is exactly right for many rate-limited calls per account.
 *
 * This workload is the opposite shape. It is a handful of calls dominated by
 * WAITING — Amazon takes minutes to generate a report. SQS pays for waiting
 * twice: every poll is a re-queue plus a Lambda invocation, and a worker that
 * sleeps instead spends its whole billed runtime asleep and still dies at the
 * timeout. A `Wait` state costs nothing and does not run code.
 *
 * The retry classification matters too. `maxReceiveCount: 3` cannot tell a 429
 * from a revoked token; a state machine can retry the first with backoff and
 * send the second straight to a recorded failure. See the ADR.
 *
 * ## Why three steps in one function
 *
 * Three Lambdas would be three build targets, three log groups and three sets
 * of grants for what is one job with one set of dependencies. The discriminator
 * costs a switch; the alternative costs three of everything.
 */

const logger = new Logger({ serviceName: 'ads-sync-worker' });
useSecretsManagerConnection();

const metrics = new Metrics({
  namespace: 'SellerOps',
  serviceName: 'ads-sync-worker',
});

/** Both report kinds this sync fetches, in the order a harvest wants them. */
const KINDS: ReportKind[] = ['search-term', 'campaign-performance'];

/**
 * How far back a scheduled run looks.
 *
 * 30 days because that is the window the harvest rules read, and because Amazon
 * restates recent days as attribution settles — a shorter window would keep
 * re-fetching data that is still moving, and a longer one costs a report we
 * would not consult.
 */
const WINDOW_DAYS = 30;

/**
 * How long Amazon's own restatement window is.
 *
 * Yesterday is not final: conversions attributed to a click keep arriving for
 * days. Ending the window one day back means a window is fetched once, when it
 * has mostly settled, rather than fetched early and then silently wrong.
 */
const LAG_DAYS = 1;

export type PlanStep = { step: 'plan'; now?: string };
export type WorkItem = {
  userId: string;
  profileId: string;
  /**
   * The stored credential's name. Credentials are keyed
   * `${apiType}::${userId}::${profileName}`, so a worker handed the advertiser
   * profile id looks up a document that does not exist and fails at mint.
   */
  profileName: string;
  /**
   * The real LWA app id. The Ads API sends it as
   * `Amazon-Advertising-API-ClientId` on EVERY request — unlike SP-API, where
   * it only feeds a token exchange the credential service performs instead — so
   * a placeholder is rejected with a bare 400.
   */
  clientId: string;
  marketplaceId: string;
  region?: string;
  /** Whose rows these are in the report store — see `collectAdsReport`. */
  sellerId: string;
  kind: ReportKind;
  from: string;
  to: string;
};
export type RequestStep = { step: 'request'; item: WorkItem };
export type CollectStep = { step: 'collect'; item: WorkItem; polls?: number };
/**
 * Sweep for backward negatives whose overlap window has closed (#147).
 *
 * Runs after the reports are in, because it reads the rows they just ingested
 * to decide whether each destination keyword is actually serving. One step for
 * the whole account rather than one per profile: it is a handful of queries,
 * and fanning it out would buy parallelism nobody is waiting on.
 */
export type ReconcileStep = { step: 'reconcile'; now?: string };
export type AdsSyncEvent = PlanStep | RequestStep | CollectStep | ReconcileStep;

type ProfileRow = {
  user_id: string;
  advertiser_profile_id: string;
  seller_id?: string;
  /** The credential document's name — NOT the advertiser profile id. */
  profile_name: string;
  /** The LWA app id, sent as a header on every Ads request. */
  client_id?: string;
  marketplace_id?: string;
  region?: string;
};

const isoDay = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * Advertiser profiles worth fetching for.
 *
 * Keyed on the ADS profile, not the seller: an ads account is its own thing and
 * this seller holds four (US, CA, MX, BR). A profile without an
 * `advertiser_profile_id` cannot be scoped in a request at all, and one without
 * a `seller_id` has nowhere to file its rows — `collectAdsReport` needs it,
 * because the manual upload path files ads exports under the seller.
 */
async function eligibleProfiles(): Promise<ProfileRow[]> {
  const { rows } = await executeQuery<ProfileRow>(
    'credentials',
    `SELECT DISTINCT user_id, advertiser_profile_id, seller_id,
            profile_name, client_id, marketplace_id, region
       FROM credentials_profiles
      WHERE api_type = 'ADS_API'
        AND advertiser_profile_id IS NOT MISSING
        AND \`deleted\` IS MISSING
        AND encrypted_secrets IS NOT MISSING
        AND (has_refresh_token IS MISSING OR has_refresh_token = TRUE)`,
    { readonly: true }
  );
  return rows;
}

/**
 * The seller each user's rows belong to, from their SP-API connection.
 *
 * Ads profiles carry no `seller_id` of their own — none of the live ones do —
 * and this worker skipped every profile that lacked one, so it planned zero
 * items on every run since it shipped and has never ingested anything.
 *
 * The account's seller is the right answer and not merely an available one: the
 * on-demand path files ads rows under exactly this id, so any other choice
 * would store the same rows twice under two sellers.
 */
async function sellerByUser(): Promise<Map<string, string>> {
  const { rows } = await executeQuery<{ user_id: string; seller_id: string }>(
    'credentials',
    `SELECT DISTINCT user_id, seller_id
       FROM credentials_profiles
      WHERE api_type = 'SP_API'
        AND seller_id IS NOT MISSING
        AND \`deleted\` IS MISSING`,
    { readonly: true }
  );
  return new Map(rows.map((row) => [row.user_id, row.seller_id]));
}

/**
 * Every usable ads profile, each with the seller its rows belong to.
 *
 * Both `plan` and `reconcile` need this and both previously skipped a profile
 * that carried no `seller_id` of its own — which is all of them — so both did
 * nothing on every run. Resolved once, here, so the two cannot disagree about
 * whose rows a profile owns.
 */
async function profilesWithSeller(): Promise<
  Array<ProfileRow & { sellerId: string }>
> {
  const [profiles, sellers] = await Promise.all([
    eligibleProfiles(),
    sellerByUser(),
  ]);
  return profiles.flatMap((profile) => {
    const sellerId = profile.seller_id ?? sellers.get(profile.user_id);
    if (!sellerId) {
      // Now genuinely exceptional: no ads seller AND no SP-API connection, so
      // there is no account to file rows under and a reconnect is the only fix.
      logger.warn(
        'ads profile has no seller id and its user has no SP-API connection',
        { userId: profile.user_id, profileId: profile.advertiser_profile_id }
      );
      return [];
    }
    return [{ ...profile, sellerId }];
  });
}

/**
 * The Ads client for one profile, which asks for tokens rather than holding
 * them (#152).
 *
 * Same seam as the SP worker: no refresh token and no client secret enter this
 * runtime. `profileId` is required by every Sponsored Products call as the
 * `Amazon-Advertising-API-Scope` header, so a client built without it
 * authenticates and then 401s on everything.
 */
function clientFor(item: WorkItem): AmazonAdsApiClient {
  // Passed straight to the job steps: `AmazonAdsApiClient` already implements
  // `requestPerformanceReport` and `fetchPerformanceReport` with exactly the
  // signatures `AdsReportClient` declares, so an adapter here would only be a
  // place for the two to drift apart.
  return new AmazonAdsApiClient({
    clientId: item.clientId,
    // The profile's own marketplace, not a hardcoded US. This account holds
    // CA, MX and BR profiles, and every one of them was being told it was US.
    marketplaceId: item.marketplaceId,
    region: (item.region ?? 'NA') as 'NA' | 'EU' | 'FE',
    profileId: item.profileId,
    mintAccessToken: () =>
      mintSellerAccessToken({
        onBehalfOf: item.userId,
        apiType: 'ADS_API',
        profileName: item.profileName,
        sellerId: item.sellerId,
        // The shed tripwire's unit. Ads has no sync domain of its own, so the
        // report kind is what identifies this work.
        domain: `ads-${item.kind}`,
      }),
  });
}

export async function handler(event: AdsSyncEvent): Promise<unknown> {
  if (event.step === 'plan') {
    const now = event.now ? new Date(event.now) : new Date();
    const to = new Date(now);
    to.setUTCDate(to.getUTCDate() - LAG_DAYS);
    const from = new Date(to);
    from.setUTCDate(from.getUTCDate() - (WINDOW_DAYS - 1));

    const profiles = await profilesWithSeller();
    const items: WorkItem[] = [];
    for (const profile of profiles) {
      const sellerId = profile.sellerId;
      if (!profile.client_id) {
        // Without the LWA app id every Ads request is rejected with a bare 400,
        // so planning the work would only produce failures an hour later.
        logger.warn('ads profile has no client id, so it cannot be called', {
          userId: profile.user_id,
          profileId: profile.advertiser_profile_id,
        });
        continue;
      }
      for (const kind of KINDS) {
        items.push({
          userId: profile.user_id,
          profileId: profile.advertiser_profile_id,
          profileName: profile.profile_name,
          clientId: profile.client_id,
          marketplaceId: profile.marketplace_id ?? 'ATVPDKIKX0DER',
          region: profile.region,
          sellerId,
          kind,
          from: isoDay(from),
          to: isoDay(to),
        });
      }
    }

    logger.info('ads sync plan', {
      profiles: profiles.length,
      items: items.length,
      from: isoDay(from),
      to: isoDay(to),
    });
    /**
     * `EligibleAdsProfiles` alongside the item count, for the same reason the
     * SP dispatcher publishes its denominator: a run that plans zero items is
     * indistinguishable from a healthy quiet night unless you can see how many
     * profiles it considered.
     */
    metrics.addMetric('EligibleAdsProfiles', MetricUnit.Count, profiles.length);
    metrics.addMetric('AdsReportsPlanned', MetricUnit.Count, items.length);
    metrics.publishStoredMetrics();

    return { items };
  }

  if (event.step === 'reconcile') {
    const now = event.now ? Date.parse(event.now) : Date.now();
    const profiles = await profilesWithSeller();

    let due = 0;
    let ready = 0;
    let blocked = 0;

    for (const profile of profiles) {
      // A funnel belongs to a user, its campaigns to a profile, and the rows to
      // a seller. The seller is the ads profile's own when it has one and the
      // account's SP-API seller otherwise — the same account either way, which
      // is what makes the substitution safe. A profile whose user has neither
      // was already dropped by `profilesWithSeller`.

      try {
        const summary = await reconcileDueNegatives({
          userId: profile.user_id,
          profileId: profile.advertiser_profile_id,
          now,
          readRows: (query) =>
            queryHarvestRows({
              sellerId: profile.sellerId,
              from: query.from,
              to: query.to,
              campaignIds: query.campaignIds,
            }),
        });

        due += summary.due;
        ready += summary.ready;
        blocked += summary.blocked;

        for (const item of summary.blockedDetail) {
          // Warn, not info. A blocked negative means a graduation stopped
          // halfway: the keyword is live downstream while the source still
          // carries the term, which is the self-competition this detects.
          logger.warn('backward negative blocked', {
            profileId: profile.advertiser_profile_id,
            graduationId: item.graduationId,
            term: item.term,
            reason: item.reason,
          });
        }
      } catch (error) {
        // One profile's failure must not abandon the rest, for the same reason
        // the Map swallows a failed report: the others are independent.
        logger.error('negative reconcile failed', {
          profileId: profile.advertiser_profile_id,
          error: error instanceof Error ? error.message : String(error),
        });
        metrics.addMetric('NegativeReconcileErrors', MetricUnit.Count, 1);
      }
    }

    /**
     * Published even at zero, so the series exists.
     *
     * `NegativesBlocked` is the one worth an alarm: it counts graduations that
     * came due and could not proceed, and a number that stays above zero for
     * days is a funnel quietly bidding against itself.
     */
    metrics.addMetric('NegativesDue', MetricUnit.Count, due);
    metrics.addMetric('NegativesReady', MetricUnit.Count, ready);
    metrics.addMetric('NegativesBlocked', MetricUnit.Count, blocked);
    metrics.publishStoredMetrics();

    logger.info('negatives reconciled', {
      profiles: profiles.length,
      due,
      ready,
      blocked,
    });
    return { due, ready, blocked };
  }

  if (event.step === 'request') {
    const { item } = event;
    const result = await requestAdsReport({
      client: clientFor(item),
      userId: item.userId,
      profileId: item.profileId,
      kind: item.kind,
      from: item.from,
      to: item.to,
    });

    if (!result.started) {
      // Declining is a normal, cheap outcome — the window is already ingested
      // or already being built. Amazon bills for generation, so re-requesting
      // would spend money to produce rows dedup then discards.
      logger.info('ads report not requested', {
        profileId: item.profileId,
        kind: item.kind,
        reason: result.reason,
      });
      return { item, state: 'skipped', reason: result.reason };
    }

    logger.info('ads report requested', {
      profileId: item.profileId,
      kind: item.kind,
      reportId: result.run.reportId,
    });
    return { item, state: 'requested', reportId: result.run.reportId };
  }

  const { item } = event;
  const result = await collectAdsReport({
    client: clientFor(item),
    userId: item.userId,
    profileId: item.profileId,
    kind: item.kind,
    sellerId: item.sellerId,
    from: item.from,
    to: item.to,
  });

  if (result.state === 'pending') {
    // Returned, not thrown. "Not ready" is the expected answer for most of a
    // report's life, and the state machine turns it back into a Wait.
    return {
      item,
      state: 'pending',
      status: result.status,
      polls: result.run.polls,
    };
  }

  if (result.state === 'failed') {
    metrics.addMetric('AdsReportsFailed', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    logger.error('ads report failed', {
      profileId: item.profileId,
      kind: item.kind,
      error: result.error,
    });
    /**
     * Returned rather than thrown, so the Map keeps going.
     *
     * One profile's report failing must not abandon the others — and the run
     * record already holds the failure, which is what stops a failed fetch
     * reading downstream as "this seller ran no ads".
     */
    return { item, state: 'failed', error: result.error };
  }

  const rowsNew = result.outcome?.rowsNew ?? 0;
  metrics.addMetric('AdsReportRowsIngested', MetricUnit.Count, rowsNew);
  metrics.publishStoredMetrics();
  logger.info('ads report ingested', {
    profileId: item.profileId,
    kind: item.kind,
    rowsNew,
    rowsDuplicate: result.outcome?.rowsDuplicate ?? 0,
  });
  return { item, state: 'ingested', rowsNew };
}
