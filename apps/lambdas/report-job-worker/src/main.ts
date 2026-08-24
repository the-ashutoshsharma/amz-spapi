import { Logger } from '@aws-lambda-powertools/logger';
import { MetricUnit, Metrics } from '@aws-lambda-powertools/metrics';
import { AmazonAdsApiClient } from '@farvisionllc/ad-client';
import { SpApiClient } from '@farvisionllc/sp-client';
import {
  adsRowsAsCsv,
  writeAdsRun,
  collectFbaReport,
  completeReportJob,
  failReportJob,
  getReportJob,
  ingestReportBuffer,
  isIngestError,
  markJobBuilding,
  requestFbaReport,
  type ReportJob,
  type ReportKind,
} from '@amz-spapi/sp-cache';
import {
  mintSellerAccessToken,
  useSecretsManagerConnection,
} from '@amz-spapi/aws-secrets';

useSecretsManagerConnection();

const logger = new Logger({ serviceName: 'report-job-worker' });
const metrics = new Metrics({
  namespace: 'SellerOps',
  serviceName: 'report-job-worker',
});

/**
 * One step of a report a user asked for in chat.
 *
 * The scheduled sync next door plans its own work; this one is handed a job id
 * and does exactly what that job says. The difference is who decided: there,
 * a schedule; here, a person who is waiting.
 *
 * ## Why the steps are separate invocations
 *
 * Amazon takes minutes to build a report. A single handler that requested and
 * then polled would be billed for the whole wait and would still die at its
 * timeout — ADR-0012's argument, and the reason the ads sync is shaped this
 * way too. `request` returns the moment Amazon accepts, the state machine
 * Waits for free, and `collect` checks once.
 *
 * ## Why this never writes to the chat
 *
 * The job document is the only thing this updates. Turning a finished job into
 * a message is the web app's business — it owns `chat-store`, the message
 * sequencing and the delivery claim — and a Lambda reaching into a
 * conversation would be a second writer to state with one owner.
 */

export type ReportJobStep =
  | { step: 'request'; jobId: string }
  | { step: 'collect'; jobId: string };

/** What the state machine branches on. Mirrors the ads sync's vocabulary. */
type StepResult =
  | { state: 'requested'; jobId: string }
  | { state: 'pending'; jobId: string; status: string }
  | { state: 'ready'; jobId: string }
  | { state: 'failed'; jobId: string; error: string };

const str = (value: unknown, fallback = ''): string =>
  typeof value === 'string' ? value : fallback;

/**
 * Where an ads report's rows are filed, by the level that was asked for.
 *
 * Only two ads kinds exist in the registry, so a `keyword` report has nowhere
 * to be stored — it keeps the older behaviour of announcing a report id for the
 * model to redeem. Adding a third kind means adding its column mapping, which
 * is a registry change rather than something to improvise here.
 */
const ADS_KIND_FOR_LEVEL: Record<string, ReportKind | undefined> = {
  campaign: 'campaign-performance',
  searchTerm: 'search-term',
  keyword: undefined,
};

/**
 * What Amazon said, not just what axios said about it.
 *
 * `error.message` for a 4xx is "Request failed with status code 400", which
 * names neither the field Amazon rejected nor the reason. The body carries
 * both, and without it a failed job tells the seller only that something went
 * wrong — which is how a missing header cost an afternoon.
 */
function describeError(error: unknown): string {
  const base = error instanceof Error ? error.message : 'Report step failed.';
  const body = (error as { response?: { data?: unknown } })?.response?.data;
  if (body === undefined || body === null) return base;
  const detail =
    typeof body === 'string' ? body : JSON.stringify(body).slice(0, 600);
  return detail ? `${base} — ${detail}` : base;
}

function adsClientFor(job: ReportJob): AmazonAdsApiClient {
  return new AmazonAdsApiClient({
    /**
     * The real LWA app id, carried on the job.
     *
     * NOT a placeholder, unlike the SP-API client next door: the Ads API sends
     * this as the `Amazon-Advertising-API-ClientId` header on every request, so
     * a stand-in string makes Amazon reject an otherwise valid report request
     * with a bare 400.
     */
    clientId: str(job.request['clientId']),
    marketplaceId: str(job.request['marketplaceId'], 'ATVPDKIKX0DER'),
    region: str(job.request['region'], 'NA') as 'NA' | 'EU' | 'FE',
    profileId: str(job.request['profileId']),
    mintAccessToken: () =>
      mintSellerAccessToken({
        onBehalfOf: job.userId,
        apiType: 'ADS_API',
        // The stored credential's name, not the advertiser profile id — the
        // credential document is keyed on it. Carried on the job because only
        // the web app, which resolved the connection, knows it.
        profileName: str(job.request['profileName']),
        sellerId: job.sellerId,
        domain: 'ads-on-demand',
      }),
  });
}

function spClientFor(job: ReportJob): SpApiClient {
  return new SpApiClient({
    sellerId: job.sellerId,
    marketplaceId: str(job.request['marketplaceId'], 'ATVPDKIKX0DER'),
    mintAccessToken: () =>
      mintSellerAccessToken({
        onBehalfOf: job.userId,
        apiType: 'SP_API',
        profileName: str(job.request['profileName']),
        sellerId: job.sellerId,
        domain: 'reports-on-demand',
      }),
  });
}

async function requestStep(job: ReportJob): Promise<StepResult> {
  if (job.kind === 'ads-performance') {
    const started = await adsClientFor(job).requestPerformanceReport({
      level: job.request['level'] as 'campaign' | 'keyword' | 'searchTerm',
      startDate: str(job.request['startDate']),
      endDate: str(job.request['endDate']),
      attribution: job.request['attribution'] as
        | '1d'
        | '7d'
        | '14d'
        | '30d'
        | undefined,
    });
    // Stored before the first poll can fail. This is the field whose loss made
    // a slow report into a second, separately billed one.
    await markJobBuilding(job.jobId, started.reportId);
    return { state: 'requested', jobId: job.jobId };
  }

  const started = await requestFbaReport({
    client: spClientFor(job),
    sellerId: job.sellerId,
    kind: job.request['reportKind'] as ReportKind,
    from: str(job.request['from']),
    to: str(job.request['to']),
  });

  if (started.state === 'requested') {
    await markJobBuilding(job.jobId, started.reportId);
    return { state: 'requested', jobId: job.jobId };
  }
  if (started.state === 'ready') {
    // Auto-generated kinds have no build step — Amazon publishes them on its
    // own cycle, so this is already finished and there is nothing to wait for.
    await completeReportJob(job.jobId, summarise(started.outcome));
    return { state: 'ready', jobId: job.jobId };
  }
  await failReportJob(job.jobId, started.error);
  return { state: 'failed', jobId: job.jobId, error: started.error };
}

async function collectStep(job: ReportJob): Promise<StepResult> {
  const reportId = job.amazonReportId;
  if (!reportId) {
    // Only reachable if `request` succeeded at Amazon and then failed to store
    // the id. Failing here is honest: the report exists, we simply cannot name
    // it, and guessing would request a duplicate.
    const error = 'Lost track of the report id before it could be collected.';
    await failReportJob(job.jobId, error);
    return { state: 'failed', jobId: job.jobId, error };
  }

  if (job.kind === 'ads-performance') {
    const result = await adsClientFor(job).fetchPerformanceReport(reportId);
    if (!result.ready) {
      if (result.status === 'FAILED') {
        const error =
          result.failureReason ?? 'Amazon could not build the report.';
        await failReportJob(job.jobId, error);
        return { state: 'failed', jobId: job.jobId, error };
      }
      return { state: 'pending', jobId: job.jobId, status: result.status };
    }

    /**
     * Store the rows NOW, while we hold them.
     *
     * The first design announced a report id and let the model fetch the rows
     * on a later turn. That makes every answer depend on how long Amazon keeps
     * a finished report available — a window we do not control and could not
     * characterise when it bit us. Ingesting here is the same path the
     * scheduled ads sync uses, so the rows end up queryable by
     * `total-report-rows` alongside every other report and Amazon is never
     * asked for them twice.
     */
    const kind = ADS_KIND_FOR_LEVEL[str(job.request['level'])];
    if (!kind) {
      await completeReportJob(job.jobId, 'Ads performance report is ready.');
      return { state: 'ready', jobId: job.jobId };
    }

    const from = str(job.request['startDate']);
    const to = str(job.request['endDate']);
    const outcome = await ingestReportBuffer({
      sellerId: job.sellerId,
      buffer: Buffer.from(
        adsRowsAsCsv({ rows: result.rows, from, to }),
        'utf8'
      ),
      source: 'api',
      kind,
      requestedFrom: from,
      requestedTo: to,
    });

    if (isIngestError(outcome)) {
      await failReportJob(job.jobId, outcome.error);
      return { state: 'failed', jobId: job.jobId, error: outcome.error };
    }

    /**
     * Record the window, or the upload guard cannot see it.
     *
     * `adsUploadOverlap` refuses a console export that collides with a window
     * already held, and it learns what is held from `sync_ads_runs`. Rows
     * ingested here without a run record are invisible to it, so the seller
     * could upload the same window and have every row land twice — the two
     * sources spell their columns differently, so dedup never fires and the
     * spend simply doubles, with both figures looking plausible.
     *
     * Best-effort: the rows are already stored and the job already succeeded,
     * so a failure to write the paperwork must not turn a good pull into a
     * reported failure. It is logged instead.
     */
    try {
      await writeAdsRun({
        userId: job.userId,
        profileId: str(job.request['profileId']),
        kind,
        from,
        to,
        status: 'ingested',
        reportId,
        rowsNew: outcome.rowsNew,
        rowsDuplicate: outcome.rowsDuplicate,
      });
    } catch (error) {
      // try/catch rather than `.catch()`: a synchronous throw never reaches a
      // promise handler, and turning a successful pull into a reported failure
      // over missing paperwork is the opposite of best-effort.
      logger.warn('ads rows ingested but the run record was not written', {
        jobId: job.jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await completeReportJob(job.jobId, summarise(outcome));
    return { state: 'ready', jobId: job.jobId };
  }

  const progress = await collectFbaReport({
    client: spClientFor(job),
    sellerId: job.sellerId,
    kind: job.request['reportKind'] as ReportKind,
    from: str(job.request['from']),
    to: str(job.request['to']),
    reportId,
  });

  if (progress.state === 'ready') {
    await completeReportJob(job.jobId, summarise(progress.outcome));
    return { state: 'ready', jobId: job.jobId };
  }
  if (progress.state === 'failed') {
    await failReportJob(job.jobId, progress.error);
    return { state: 'failed', jobId: job.jobId, error: progress.error };
  }
  return { state: 'pending', jobId: job.jobId, status: progress.status };
}

/** One line a person can read, in the words the chat will repeat. */
function summarise(outcome: {
  rowsNew: number;
  rowsDuplicate: number;
  rowsRefreshed: number;
}): string {
  const parts = [`${outcome.rowsNew} new rows`];
  if (outcome.rowsDuplicate)
    parts.push(`${outcome.rowsDuplicate} already held`);
  if (outcome.rowsRefreshed) {
    parts.push(`${outcome.rowsRefreshed} re-read under the current mapping`);
  }
  return `${parts.join(', ')}.`;
}

export async function handler(event: ReportJobStep): Promise<StepResult> {
  const job = await getReportJob(event.jobId);
  if (!job) {
    /**
     * Returned, not thrown. A job that expired or was purged is gone, and a
     * retry policy cannot bring it back — throwing would spend five attempts
     * proving that, then fail an execution nobody is waiting on any more.
     */
    logger.warn('report job not found', { jobId: event.jobId });
    return { state: 'failed', jobId: event.jobId, error: 'Job not found.' };
  }

  try {
    const result =
      event.step === 'request'
        ? await requestStep(job)
        : await collectStep(job);

    logger.info('report job step', {
      jobId: job.jobId,
      kind: job.kind,
      step: event.step,
      state: result.state,
    });
    if (result.state === 'ready') {
      metrics.addMetric('ReportJobsReady', MetricUnit.Count, 1);
      metrics.publishStoredMetrics();
    }
    if (result.state === 'failed') {
      metrics.addMetric('ReportJobsFailed', MetricUnit.Count, 1);
      metrics.publishStoredMetrics();
    }
    return result;
  } catch (error) {
    /**
     * A thrown step is a job nobody will ever be told about, because the only
     * record the chat reads is the job document. Recording the failure here is
     * what keeps "it broke" from looking identical to "it is still building".
     */
    const message = describeError(error);
    logger.error('report job step threw', { jobId: job.jobId, error: message });
    await failReportJob(job.jobId, message).catch(() => null);
    metrics.addMetric('ReportJobsFailed', MetricUnit.Count, 1);
    metrics.publishStoredMetrics();
    return { state: 'failed', jobId: job.jobId, error: message };
  }
}
