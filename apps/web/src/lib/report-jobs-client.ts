import { SFNClient, StartExecutionCommand } from '@aws-sdk/client-sfn';
import {
  createReportJob,
  type ReportJob,
  type ReportJobKind,
} from '@amz-spapi/sp-cache';
import { awsCredentials } from './aws-credentials';
import { loggerFor } from './logger';

const log = loggerFor('report-jobs');

/**
 * Hand a report to something that is allowed to wait for it.
 *
 * The chat turn's part is over in a second: write the job, start the execution,
 * tell the user it is running. Everything after that happens in Step Functions
 * and lands on the job document, which the chat reads back through
 * `/api/chat/[chatId]/jobs`.
 *
 * ## Why the job is written before the execution starts
 *
 * The job document is what the user is shown. If the order were reversed, a
 * failure to write it would leave a report building at Amazon that nothing can
 * name, report on, or collect — invisible work the seller still pays for. This
 * way the worst case is a job stuck at `queued`, which is visible and can be
 * retried.
 */

let client: SFNClient | undefined;

function sfn(): SFNClient {
  if (!client) {
    client = new SFNClient({
      region: process.env['AWS_REGION'] ?? 'us-east-1',
      credentials: awsCredentials(),
    });
  }
  return client;
}

export type StartReportJobResult =
  | { started: true; job: ReportJob }
  | { started: false; job?: ReportJob; error: string };

export async function startReportJob(params: {
  userId: string;
  chatId: string;
  sellerId: string;
  kind: ReportJobKind;
  request: Record<string, unknown>;
}): Promise<StartReportJobResult> {
  const stateMachineArn = process.env['REPORT_JOBS_STATE_MACHINE_ARN'];
  if (!stateMachineArn) {
    /**
     * Refused rather than silently falling back to running it in-request.
     *
     * A fallback would work locally and then reintroduce, in production, the
     * exact failure this replaced: a multi-minute report inside a 300-second
     * route, thrown away when the route dies.
     */
    return {
      started: false,
      error:
        'Background reports are not configured in this environment ' +
        '(REPORT_JOBS_STATE_MACHINE_ARN is unset).',
    };
  }

  const job = await createReportJob(params);

  try {
    await sfn().send(
      new StartExecutionCommand({
        stateMachineArn,
        // Named after the job so a duplicate start is refused by Step Functions
        // rather than building the same report twice. Execution names must be
        // unique for 90 days, and the job id is already unique and opaque.
        name: `job-${job.jobId}`,
        input: JSON.stringify({ jobId: job.jobId }),
      })
    );
    return { started: true, job };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Could not start the report.';
    log.error({ jobId: job.jobId, error: message }, 'report job start failed');
    return { started: false, job, error: message };
  }
}
