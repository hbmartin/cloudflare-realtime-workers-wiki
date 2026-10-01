# Phase 10: operations incidents and the Slack operations channel

Status: planned (Round 2, Track B). This plan closes Slack roadmap
[Milestone 5](../SLACK_INTEGRATION_ROADMAP.md#milestone-5--operations-channel-and-ga-hardening). The incident ledger
and DLQ consumer have no Slack dependency and can ship first.

## User contract and baseline audit

A workspace owner can configure one operations channel per Slack installation, separate from content mappings. Every
distinct durable failure posts exactly one message there:

- An import or export job reaches a terminal failed state.
- A delivery message reaches the dead-letter queue.
- A document crosses the 16 MiB warning threshold.
- A document crosses the sticky 24 MiB read-only threshold.

Each message carries safe identifiers, the error category, the time, the retry state, and a remediation link. Owners
can also see incidents in NoteFlare without Slack. Removing the operations channel stops new posts but keeps the
incident records.

Baseline, audited 1 October 2026 at `2ef1450`:

- `slack_operations_destinations` and `slack_incidents` exist in migration `0035`, but nothing reads or writes them.
  `slack_incidents` is keyed by installation, so it cannot record an incident when Slack is not installed.
- Every environment in `wrangler.jsonc` configures a `dead_letter_queue` for the delivery queue, but no consumer
  reads it. The single `queue()` handler in `src/worker/index.ts` handles only the primary queue, so dead-lettered
  messages are invisible.
- `src/worker/document.ts` defines `WARN_BYTES` (16 MiB) and `READ_ONLY_BYTES` (24 MiB) and sets `oversized` and
  `read_only`, with no incident hook. `src/worker/jobs.ts` marks jobs `failed` in several places, with no common
  terminal-failure hook.
- Delivery health exists (`slack_delivery_failures`, migration `0043`; owner endpoints in `src/worker/index.ts`).

## Interfaces and data flow

- **Incident ledger.** Add `operational_incidents` with a unique `source_key`, `category`, an allowlisted
  `resource_kind` and `resource_id`, `occurred_at`, `retry_state`, and `resolved_at`. Producers insert with
  `ON CONFLICT(source_key) DO NOTHING`. Source keys are:
  - `job:<id>:<attempt>` for job failures.
  - `dlq:<message id>` for dead-lettered messages.
  - `doc-size:<page>:<epoch>:<threshold>` for size transitions.

  Retries of one incident collapse; distinct failures never do. Store no document, comment, or import content and no
  raw exception text, only a bounded error category from the existing redaction path. Reuse `slack_incidents` as the
  per-installation delivery record (`source_key` → posted `channel` and `ts`).

- **Producers.** Route every terminal `jobs` failure through one `recordJobTerminalFailure` helper. Emit a size
  incident from the document room after a snapshot persists when it crosses a threshold. The size transition is
  durable: emit once per epoch and threshold, and do not emit again on reload. Add a DLQ consumer binding for each
  environment's `delivery-dlq`. It records the incident from the message topic and an opaque ID, then acknowledges the
  message. It never re-delivers the original effect.
- **Operations channel.** Owner-only API and Slack Settings UI to set, validate (Phase 9 validation), enable, and
  remove `slack_operations_destinations`. Expose destination health on `SlackStatus`. A `slack_ops_alert` outbox
  topic posts one Block Kit message per incident and records it in `slack_incidents`. If a `slack_ops_alert` message
  itself dead-letters, the DLQ consumer records telemetry and stops. It must never create an incident about an ops
  alert.
- **In-app view.** Add an owner-only incident list in workspace settings, with paging and filters, so operators
  without Slack still see failures. This satisfies part of IDEAS #35.

## Migration, rollout, and recovery

The additive migration adds `operational_incidents`, incident columns on `slack_incidents` if needed, and the DLQ
consumer bindings. Ship in this order:

1. Ledger, producers, and DLQ consumer, with no Slack posting. Watch volumes for a week.
2. Owner incident list.
3. Operations-channel configuration and `slack_ops_alert` behind `SLACK_OPS_ALERTS_ENABLED`.

Disabling the flag stops posts while recording continues. A backlog after re-enabling posts each incident once, in
order. Update `docs/CONFIGURATION.md`, `docs/OPERATIONS.md`, `docs/TROUBLESHOOTING.md`, and `SECURITY.md` with the
runbook and the field allowlist.

## Exit matrix

| Scenario                                                     | Required result                                                             |
| ------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Job fails terminally, then a retry of the same attempt fails | One incident and one post; a new attempt that fails is a second incident    |
| Delivery message exhausts retries                            | DLQ consumer records one incident; original effect is not replayed          |
| Document crosses 16 MiB, then 24 MiB, then reloads           | Exactly two incidents for that epoch                                        |
| `slack_ops_alert` dead-letters                               | Telemetry only; no incident, no loop                                        |
| No Slack installation, or destination removed                | Incidents still recorded and listed in-app; no Slack call                   |
| Incident with hostile error text or a page title             | Post contains only allowlisted fields                                       |
| Flag off, then on, with a backlog                            | Each pending incident posted once                                           |
| Owner demoted, or channel archived                           | Configuration denied, or destination blocked with reason; ledger unaffected |
