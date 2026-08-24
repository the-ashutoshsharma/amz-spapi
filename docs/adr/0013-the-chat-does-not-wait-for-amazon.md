# ADR-0013: The chat does not wait for Amazon; a job outlives the turn

- **Status:** Accepted
- **Date:** 2026-08-21
- **Deciders:** Byron Warner
- **Supersedes nothing.** Extends [ADR-0012](0012-queues-pace-accounts-state-machines-wait.md).

## Context

Amazon builds reports asynchronously, commonly over minutes. A chat turn has 300
seconds for the model, every other tool and streaming combined. Both report paths
in the chat resolved that mismatch by making the **user** the scheduler, in two
different and equally bad ways.

**Ads reports asked the user to come back.** `request-ad-report` returned a
report id in about a second, and the tool description instructed the model to
"give them the reportId and END YOUR TURN… When they come back, or after a
minute or two of other work, fetch it." The delivery mechanism was the user
remembering to ask again. That is not a bug in the model's behaviour — it was
doing exactly what it was told.

**FBA reports blocked, and then discarded the work.** `sync-report` polled
in-turn for `REPORT_TIMEOUT_MS.requestSafe` (90s) and then threw:

> Report … still IN_PROGRESS after 90s (reportId abc). The report is still being
> built — reuse this id rather than requesting it again.

No tool accepted a report id. `sync-report`, `check-report-coverage` and
`total-report-rows` take windows and kinds, not ids. So the advice was
un-actionable: the model could not reuse the id, and the next attempt asked
Amazon to build the same report from scratch. Amazon bills for generation either
way, and a rebuild looks like success — the right rows arrive, just later and
paid for twice.

The comment on `runReport` already documented this class of bug for the previous
ten-minute default. Cutting the timeout to 90s made it faster, not different.

## Why this is not just ADR-0012 again

ADR-0012 established that waiting-dominated Amazon work belongs in Step
Functions rather than a queue, and the scheduled ads sync was built that way.
Everything in that argument applies here — the wait is minutes, a `Wait` state
costs nothing, a Lambda that sleeps is billed for sleeping and still dies at its
timeout.

What ADR-0012 does not cover is that **somebody is waiting**. A scheduled job
answers to a cron expression; this one answers to a person watching a chat pane.
That difference decides three things a copy of the scheduled machine would get
wrong: there is no `plan` step (the work is one job, named in the input, and a
planner that re-derived it could disagree with what the user was told), there is
no schedule (every execution is a request), and the outcome has to reach a
conversation rather than only a run record.

## Decision

**A report requested in chat becomes a durable job, and the turn ends
immediately.**

```
tool → ops.startReportJob → write ops.report_jobs → StartExecution
                                                          │
                               request → Wait → collect → (Wait → collect)…
                                                          │
                                            worker writes status to the job
                                                          │
          browser polls /api/chat/{chatId}/jobs → claim → message in the chat
```

Four rules make it safe.

**The job is written before the execution starts.** Reversed, a failed write
leaves a report building at Amazon that nothing can name, collect or report on —
invisible work the seller still pays for. This way the worst case is a job stuck
at `queued`, which is visible and retryable.

**`amazonReportId` is stored the moment Amazon accepts the request**, before the
first poll. That single field is what turns a slow report into a resumable one
rather than a rebuilt one, and it is the reason `syncReport` was split into
`requestFbaReport` and `collectFbaReport`.

**Delivery is claimed, not flagged.** A finished job must become exactly one
message. Retries are expected — Step Functions retries Lambdas, a reconnecting
browser re-reads pending jobs, a second tab polls the same chat. "Check
`deliveredAt`, then set it" races two deliverers into two identical messages, so
`claimDelivery` INSERTs a separate claim document and the first caller wins.
Insert-if-absent is the only atomic primitive the Data API offers
([ADR-0010](0010-lambdas-reach-couchbase-over-the-data-api.md)).

**The worker never writes to the chat.** It updates the job document only.
`chat-store` owns message sequencing and lives in the web app; a Lambda
appending to a conversation would be a second writer to state with one owner,
and that seq accounting is precisely what breaks quietly when two processes both
believe they are authoritative.

### Delivery is polled, not pushed

The browser polls `/api/chat/{chatId}/jobs` while a job is in flight, and not
at all otherwise.

SSE was the obvious choice and is the wrong one here. A Vercel route is capped at
300 seconds, so the connection is torn down and re-established on a timer
regardless, billed for its whole life, while the server itself polls Couchbase
behind it. SSE earns its keep when the server learns something the instant it
happens; here the event is minutes away and the server is polling too. Polling
costs nothing when nothing is pending, which is almost always, and it pauses
while the tab is hidden.

The transport is the replaceable part. A push channel (Pusher or similar) swaps
in by changing the client and the route, because the job document — not the
connection — is what holds the state.

### Ads reports deliver a notification, not an answer

The two report kinds mean different things by "the report". FBA ingests rows into
the report store, so a finished job is self-describing: "412 new rows." Ads
reports are transient — `fetchPerformanceReport` hands rows to the model to
interpret, which is where the quality is.

So a finished ads job posts "your report is ready" carrying the report id, and
the model reads the rows on the next turn with the `get-ad-report` tool it
already has. The alternative — summarising spend inside the worker — needs
either an LLM call in a Lambda or a fixed template that is worse than what the
chat already produces. The cost is one model turn per report, which is the same
turn that was being spent when the user came back to ask.

## Options considered

**Keep blocking, raise the timeout.** Rejected: no timeout fits inside a
300-second route that also has to run a model. This is the failure being
replaced.

**Run it in the route with `waitUntil`.** Rejected: work continues after the
response but still dies with the function, and nothing durable records that it
was ever started.

**A queue instead of a state machine.** Rejected by ADR-0012's argument — polling
through SQS charges for the wait twice, once as a re-queue and once as an
invocation.

**Reuse the ads sync's state machine with an on-demand entry point.** Tempting,
and rejected: its `plan` step, its Map, its schedule and its per-item semantics
all exist for a fan-out this job does not have. The shape is shared; the
machinery is not.

## Consequences

- Two state machines with a similar silhouette, distinguished by their entry
  points. `ads-sync-wiring` starts from a schedule; `report-jobs-wiring` starts
  from `StartExecution` granted to the Vercel role and nothing else.
- The web app gains `states:StartExecution` on one machine — its first AWS
  permission beyond S3.
- `REPORT_JOBS_STATE_MACHINE_ARN` unset **refuses** rather than falling back to
  the in-turn path. A fallback would work locally and reintroduce the original
  bug in production.
- Tools keep the in-turn path for hosts that offer no background runner, chosen
  by whether the optional `startReportJob` op is present. That is deliberate
  duplication, and the only kind here: one path is durable, the other is what a
  local CLI can do.
- A job whose message write fails after its claim is spent is lost to the
  conversation and visible only in logs. Bounded and logged loudly, but real.

## What this does not decide

Whether reports should be requested at all without a person asking — a seller
who wants yesterday's ledger every morning is the scheduled sync's problem, not
this one. Nor whether the polling transport stays; that is a cost question to
revisit when a chat routinely has several reports in flight.
