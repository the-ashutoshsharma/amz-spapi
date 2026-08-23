import * as cdk from 'aws-cdk-lib';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { Construct } from 'constructs';
import type { StageConfig } from '../config/stages.js';

/**
 * On-demand reports, requested from the chat.
 *
 *   web /authorize → StartExecution → request → Wait → collect → (Wait → …)
 *
 * ## Why a state machine and not "just await it in the route"
 *
 * Amazon takes minutes to build a report and a Vercel route gets 300 seconds
 * for an entire turn — the model, every other tool, and streaming included.
 * The old `sync-report` blocked in-turn for 90s and then threw away a report
 * that was still being built, so the next attempt made Amazon build it again.
 * ADR-0012's rule sends waiting-dominated work here, and this is the same shape
 * as `ads-sync-wiring` next door for exactly that reason.
 *
 * ## Why there is no schedule
 *
 * The only difference from the ads sync: nothing here fires on a timer. Every
 * execution is a person asking, so the entry point is `StartExecution` granted
 * to the web app's role rather than an EventBridge rule. There is deliberately
 * no `plan` step either — the work is one job, named in the input, and a
 * planner that re-derived it could disagree with what the user was told.
 *
 * ## Why failures are Succeed states
 *
 * A report that Amazon cancels is recorded on the job document, which is the
 * only thing the chat reads. Failing the execution as well would add a second,
 * less informative record of a fact already handled, and would page someone
 * about a seller having no data in a date range.
 */
export interface ReportJobsWiringProps {
  config: StageConfig;
  /** Discovered by LambdasStack, which owns it. */
  worker: lambda.Function;
  /** Existing alarm topic, so these land where the other alarms already do. */
  alarmTopic?: sns.ITopic;
}

export class ReportJobsWiring extends Construct {
  public readonly stateMachine: sfn.StateMachine;

  constructor(scope: Construct, id: string, props: ReportJobsWiringProps) {
    super(scope, id);
    const { config, worker } = props;
    const prefix = `${config.appName}-${config.stageName}-report-jobs`;

    /**
     * Transient faults only, matching the ads machine.
     *
     * A revoked token or a rejected date range will not succeed on the third
     * attempt, and retrying spends minutes proving it while someone watches an
     * empty chat. Those outcomes are written to the job instead.
     */
    const transientRetry = {
      errors: [
        'Lambda.TooManyRequestsException',
        'Lambda.ServiceException',
        'Lambda.AWSLambdaException',
        'Lambda.SdkClientException',
      ],
      interval: cdk.Duration.seconds(30),
      backoffRate: 2,
      maxAttempts: 4,
    };

    const request = new tasks.LambdaInvoke(this, 'RequestReport', {
      lambdaFunction: worker,
      payload: sfn.TaskInput.fromObject({
        step: 'request',
        'jobId.$': '$.jobId',
      }),
      resultPath: '$.request',
      resultSelector: { 'state.$': '$.Payload.state' },
    }).addRetry(transientRetry);

    /**
     * Thirty seconds before the first look.
     *
     * Shorter than the ads sync's minute because someone is watching this one.
     * Still long enough that the first poll is not spent being told PROCESSING:
     * a Wait costs nothing, an invocation does.
     */
    const firstWait = new sfn.Wait(this, 'WaitBeforeFirstCheck', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const laterWait = new sfn.Wait(this, 'WaitBetweenChecks', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });

    const collect = new tasks.LambdaInvoke(this, 'CollectReport', {
      lambdaFunction: worker,
      payload: sfn.TaskInput.fromObject({
        step: 'collect',
        'jobId.$': '$.jobId',
      }),
      resultPath: '$.collect',
      resultSelector: { 'state.$': '$.Payload.state' },
    }).addRetry(transientRetry);

    const done = new sfn.Succeed(this, 'Done');

    // `pending` goes back to a Wait; anything else is written on the job and
    // this execution has nothing left to do.
    const afterCollect = new sfn.Choice(this, 'ReportReady?')
      .when(sfn.Condition.stringEquals('$.collect.state', 'pending'), laterWait)
      .otherwise(done);

    laterWait.next(collect);
    collect.next(afterCollect);

    // A request that finished or failed outright never enters the poll loop:
    // auto-generated report kinds are already published, and a refused request
    // has nothing to collect.
    const afterRequest = new sfn.Choice(this, 'RequestAccepted?')
      .when(
        sfn.Condition.stringEquals('$.request.state', 'requested'),
        firstWait
      )
      .otherwise(new sfn.Succeed(this, 'NothingToCollect'));

    request.next(afterRequest);
    firstWait.next(collect);

    this.stateMachine = new sfn.StateMachine(this, 'ReportJobsStateMachine', {
      stateMachineName: prefix,
      definitionBody: sfn.DefinitionBody.fromChainable(request),
      /**
       * An hour, against the ads sync's two.
       *
       * A scheduled report can afford to grind; one a person is waiting for
       * cannot. The job's own TTL outlives this, so an execution that times out
       * still leaves a readable record rather than a job stuck at `building`.
       */
      timeout: cdk.Duration.hours(1),
      stateMachineType: sfn.StateMachineType.STANDARD,
      tracingEnabled: true,
    });

    /**
     * The web app starts these, and may do nothing else here.
     *
     * `grantStartExecution` only — not `grantRead`, not `grantTaskResponse`.
     * The chat needs to ask for a report; it reads the answer from Couchbase
     * like everything else, so an execution-history grant would widen the
     * Vercel role for a capability nothing uses.
     */
    if (config.vercel) {
      const vercelRole = iam.Role.fromRoleName(
        this,
        'VercelRole',
        `${config.appName}-${config.stageName}-vercel`
      );
      this.stateMachine.grantStartExecution(vercelRole);
    }

    if (props.alarmTopic) {
      /**
       * Executions that FAIL, which now means the machine itself broke —
       * a report Amazon cancelled succeeds here and is recorded on the job.
       * So any datapoint is worth a look, and the threshold is one.
       */
      new cloudwatch.Alarm(this, 'ReportJobsFailed', {
        alarmName: `${prefix}-executions-failed`,
        alarmDescription:
          'A chat-initiated report execution failed outright. Seller-visible ' +
          'outcomes (no data, revoked token) are written to the job document ' +
          'and succeed, so this means the machine or the worker broke.',
        metric: this.stateMachine.metricFailed({
          period: cdk.Duration.minutes(5),
        }),
        threshold: 1,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new actions.SnsAction(props.alarmTopic));
    }

    new cdk.CfnOutput(this, 'ReportJobsStateMachineArn', {
      value: this.stateMachine.stateMachineArn,
      description:
        'Set as REPORT_JOBS_STATE_MACHINE_ARN in the web app environment.',
    });
  }
}
