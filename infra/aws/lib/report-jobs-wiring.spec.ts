import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { STAGES } from '../config/stages.js';
import { ReportJobsWiring } from './report-jobs-wiring.js';

/**
 * The on-demand report machine, which differs from the scheduled ads one in
 * ways that are easy to lose in a copy-paste.
 *
 * The failures worth guarding are all silent. A machine with no Wait still
 * works and bills a Lambda invocation per poll. A machine that fires on a
 * schedule would build reports nobody asked for and charge the seller for
 * them. And a Vercel role granted more than StartExecution would widen the
 * blast radius of the one credential that lives outside AWS.
 */

function synth() {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestStack', {
    env: { account: '111111111111', region: 'us-east-1' },
  });
  const worker = new lambda.Function(stack, 'ReportWorker', {
    runtime: lambda.Runtime.NODEJS_24_X,
    handler: 'main.handler',
    code: lambda.Code.fromInline('export const handler = async () => {};'),
  });

  new ReportJobsWiring(stack, 'ReportJobs', {
    config: STAGES.dev,
    worker,
    alarmTopic: new sns.Topic(stack, 'Alarms'),
  });
  return Template.fromStack(stack);
}

/** The machine definition, as the object CloudFormation will receive. */
function definition(template: Template): Record<string, unknown> {
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const body = Object.values(machines)[0].Properties.DefinitionString;
  const joined = (body['Fn::Join']?.[1] ?? [])
    .map((part: unknown) => (typeof part === 'string' ? part : 'ARN'))
    .join('');
  return JSON.parse(joined);
}

const states = (template: Template) =>
  definition(template).States as Record<string, Record<string, unknown>>;

describe('the machine', () => {
  it('is STANDARD, so a report that took ten minutes still has a history', () => {
    synth().hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineType: 'STANDARD',
    });
  });

  it('waits between polls instead of invoking in a loop', () => {
    const waits = Object.values(states(synth())).filter(
      (state) => state.Type === 'Wait'
    );
    // Step Functions bills transitions, not elapsed time; a poll loop with no
    // Wait costs a Lambda invocation per check to be told PROCESSING.
    expect(waits.length).toBeGreaterThan(0);
  });

  it('sends a pending report back to a wait rather than ending', () => {
    const choice = Object.values(states(synth())).find(
      (state) =>
        state.Type === 'Choice' &&
        JSON.stringify(state).includes('$.collect.state')
    );
    expect(JSON.stringify(choice)).toContain('pending');
  });

  it('never enters the poll loop for a request that did not start one', () => {
    const choice = Object.values(states(synth())).find(
      (state) =>
        state.Type === 'Choice' &&
        JSON.stringify(state).includes('$.request.state')
    );
    // Auto-generated kinds are already published and a refused request has
    // nothing to collect; polling either would wait an hour for nothing.
    expect(JSON.stringify(choice)).toContain('requested');
  });

  it('retries only transient Lambda faults', () => {
    const retried = JSON.stringify(states(synth()));
    expect(retried).toContain('Lambda.ServiceException');
    // A revoked token or a rejected date range will not come good on attempt
    // three, and the job document already carries the reason.
    expect(retried).not.toContain('States.ALL');
  });
});

describe('who can start it', () => {
  it('grants the web role permission to start executions', () => {
    synth().hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Action: 'states:StartExecution' }),
        ]),
      }),
    });
  });

  it('does not grant the web role execution history or task responses', () => {
    const policies = JSON.stringify(synth().findResources('AWS::IAM::Policy'));
    // The chat reads outcomes from Couchbase like everything else, so these
    // would be reach the app never uses.
    expect(policies).not.toContain('states:DescribeExecution');
    expect(policies).not.toContain('states:SendTaskSuccess');
  });

  it('has no schedule, because every execution is a person asking', () => {
    // A timer here would build reports nobody requested — and Amazon bills for
    // generation whether or not anyone reads the result.
    synth().resourceCountIs('AWS::Scheduler::Schedule', 0);
    synth().resourceCountIs('AWS::Events::Rule', 0);
  });
});

describe('alarms', () => {
  it('pages on a failed execution, not on a seller having no data', () => {
    synth().hasResourceProperties('AWS::CloudWatch::Alarm', {
      MetricName: 'ExecutionsFailed',
      Threshold: 1,
    });
  });
});
