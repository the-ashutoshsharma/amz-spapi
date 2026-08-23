import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Handing a report to something that is allowed to wait for it.
 *
 * Three properties matter here, and all three fail silently if broken:
 *
 * ## Refusing beats falling back
 *
 * With no state machine configured the honest answer is "not available". A
 * fallback to running the report in-request would work locally and then, in
 * production, reintroduce exactly what this replaced — a multi-minute Amazon
 * report inside a 300-second route, discarded when the route dies.
 *
 * ## The job is written before the execution starts
 *
 * Reversed, a failure to write the job leaves a report building at Amazon that
 * nothing can name, collect or report on — invisible work the seller still pays
 * for. This way the worst case is a job stuck at `queued`, which is visible.
 *
 * ## A failed start still returns its job
 *
 * The job exists whether or not the machine accepted it, and the caller needs
 * it to say something truthful about what happened.
 */

// Hoisted: `vi.mock` factories run before module-scope consts exist, so a
// factory closing over a plain `const` throws a temporal-dead-zone error that
// surfaces as the call under test merely "failing".
const { createReportJob, send, StartExecutionCommand } = vi.hoisted(() => ({
  createReportJob: vi.fn(),
  send: vi.fn(),
  StartExecutionCommand: vi.fn((input: unknown) => ({ input })),
}));

vi.mock('@amz-spapi/sp-cache', () => ({
  createReportJob: (...args: unknown[]) => createReportJob(...args),
}));

vi.mock('@aws-sdk/client-sfn', () => ({
  SFNClient: vi.fn(() => ({ send: (...args: unknown[]) => send(...args) })),
  StartExecutionCommand,
}));

vi.mock('./aws-credentials', () => ({ awsCredentials: () => undefined }));

vi.mock('./logger', () => ({
  loggerFor: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const { startReportJob } = await import('./report-jobs-client');

const ARN = 'arn:aws:states:us-east-1:1:stateMachine:sellavant-dev-report-jobs';
const REQUEST = {
  userId: 'auth0|seller',
  chatId: 'chat_1',
  sellerId: 'A1SELLER',
  kind: 'fba-report' as const,
  request: { reportKind: 'ledger-detail' },
};

const original = process.env['REPORT_JOBS_STATE_MACHINE_ARN'];

beforeEach(() => {
  vi.clearAllMocks();
  process.env['REPORT_JOBS_STATE_MACHINE_ARN'] = ARN;
  createReportJob.mockResolvedValue({ jobId: 'job-1', ...REQUEST });
  send.mockResolvedValue({});
});

afterEach(() => {
  if (original === undefined)
    delete process.env['REPORT_JOBS_STATE_MACHINE_ARN'];
  else process.env['REPORT_JOBS_STATE_MACHINE_ARN'] = original;
});

describe('when no state machine is configured', () => {
  it('refuses instead of quietly running the report in-request', async () => {
    delete process.env['REPORT_JOBS_STATE_MACHINE_ARN'];

    const result = await startReportJob(REQUEST);

    expect(result.started).toBe(false);
    expect(result).toMatchObject({
      error: expect.stringContaining('REPORT_JOBS_STATE_MACHINE_ARN'),
    });
    // No job either: a queued job nothing will ever run is worse than a refusal.
    expect(createReportJob).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });
});

describe('starting a job', () => {
  it('writes the job before asking the machine to run it', async () => {
    const order: string[] = [];
    createReportJob.mockImplementation(async () => {
      order.push('job');
      return { jobId: 'job-1' };
    });
    send.mockImplementation(async () => {
      order.push('execution');
      return {};
    });

    await startReportJob(REQUEST);

    expect(order).toEqual(['job', 'execution']);
  });

  it('names the execution after the job so a double start is refused', async () => {
    await startReportJob(REQUEST);

    // Step Functions rejects a duplicate execution name for 90 days, which is
    // what stops the same report being built and billed twice.
    expect(StartExecutionCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        stateMachineArn: ARN,
        name: 'job-job-1',
        input: JSON.stringify({ jobId: 'job-1' }),
      })
    );
  });

  it('passes only the job id, so the worker reads the job as stored', async () => {
    await startReportJob(REQUEST);

    const [{ input }] = StartExecutionCommand.mock.calls[0] as [
      { input: string }
    ];
    // Copying the request into the execution input would let the two disagree
    // about what was asked for.
    expect(JSON.parse(input)).toEqual({ jobId: 'job-1' });
  });

  it('reports success with the stored job', async () => {
    const result = await startReportJob(REQUEST);
    expect(result).toMatchObject({ started: true, job: { jobId: 'job-1' } });
  });
});

describe('when the machine refuses', () => {
  it('returns the job anyway, so the caller can say what happened', async () => {
    send.mockRejectedValue(new Error('ExecutionAlreadyExists'));

    const result = await startReportJob(REQUEST);

    expect(result.started).toBe(false);
    // The job is real and stored; only the execution failed. Losing the handle
    // here would leave a queued job nobody can explain.
    expect(result.job).toMatchObject({ jobId: 'job-1' });
    expect(result).toMatchObject({
      error: expect.stringContaining('ExecutionAlreadyExists'),
    });
  });

  it('does not throw into the chat turn', async () => {
    send.mockRejectedValue(new Error('access denied'));
    await expect(startReportJob(REQUEST)).resolves.toBeTruthy();
  });
});
