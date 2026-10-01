# Phase 3: date mentions and reminders

Status: implemented in #203 (merged 30 September 2026) and deployed to production with no
flag. Migrations `0057`, `0059`, and `0060` are applied. Live checks of scheduler lag and email
and Slack delivery are pending.

## User contract

Typing `@` in a document can insert an editable date token through a date picker, alongside the
existing page and person mentions. The picker accepts an explicit date/time and common relative
phrases, previews the resolved value in the member's timezone, and stores an absolute instant plus
timezone for timed dates or a calendar date for all-day dates. Display formatting follows the
viewer's locale, while editing shows the original timezone and whether the value is all-day.
Changing a token changes its displayed date for every collaborator.

The author may attach **Remind me** to a token. Available choices are at time, 5 minutes before,
1 hour before, 1 day before, and a custom absolute time. A reminder belongs to that author, is
private in the editor, and opens the containing page when delivered. An all-day date defaults to
09:00 in its stored timezone; daylight-saving gaps advance to the next valid local instant, and
repeated times use the earlier occurrence. A past due time is rejected with a clear message.
Rescheduling or removing the token updates or cancels its reminder. Other collaborators can edit
the date but cannot create, view, or change the author's reminder setting.

## Interfaces and data flow

- Add a `dateMention` inline content spec beside `mention` in `src/client/mentions.tsx`. Give each
  token a stable UUID and structured date value; do not store a locale-formatted string as the
  source of truth. The Yjs document remains authoritative for the shared date. Export/import
  Markdown uses a readable date link or text fallback, without leaking reminder metadata.
- Add authenticated `PUT /api/pages/:pageId/date-reminders/:tokenId` and `DELETE` for the signed-in
  author. `PUT` accepts the token's current date revision and a reminder offset or absolute due
  instant. Return the effective due time and reminder revision. A stale token revision is 409;
  missing token or inaccessible page is 404. The server validates the token against the document
  room, not just a client-supplied timestamp.
- Add `date_reminders` with `(page_id, token_id, user_id)` unique, due time, timezone, token
  revision, generation, state, and delivery receipt ID. The document room emits durable token
  change/removal events after persistence. A reconciler updates reminders for edited tokens and
  cancels orphaned rows; it also catches missed events on a bounded sweep.
- Extend the existing `*/15 * * * *` scheduled handler to claim due reminder generations
  transactionally. Recheck page existence and the member's current read access just before
  creating the notification. Add `reminder` to notification event types/preferences and reuse the
  existing inbox, email, and Slack fanout policy. Make the due event ID deterministic from the
  reminder ID and generation so a cron retry or fanout replay creates one logical notification.
  Deliver the in-app event within 15 minutes of due time under normal service conditions; channel
  delivery follows its configured preference and retry policy.

Creation, rescheduling, and cancellation are generation changes. A claimed old generation may
finish only if it still matches the current row. Deleting, archiving, or losing access to the page
cancels future delivery; restoring access does not resurrect a canceled event. Deleting a user's
account removes their rows. Concurrent token edits resolve through the document room's final
token revision; the author sees the recalculated due time or a canceled-reminder notice.

## Migration, rollout, and recovery

Add the D1 table and event-type preference default (`inApp: true`, other channels following the
current preference defaults). Existing documents need no rewrite; unknown date tokens in older
clients show a readable fallback. Deploy readers and schema before enabling the date picker,
then the write endpoint, then the scheduler. The scheduler must not run for rows created by an
unreleased client format. Replaying document events or a due scan is safe because generations and
notification IDs are unique. If scheduler delivery fails, keep the claim retryable and expose
age of oldest due event as a metric; never silently mark it sent.

## Exit matrix

| Scenario                                                  | Required result                                                       |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| Create, edit, and remove a date token in two tabs         | Both tabs show the same date; authored reminder is private            |
| All-day and timed dates across DST and timezone change    | Effective due instant and display match the documented rules          |
| Reschedule/cancel at the due boundary; cron retries twice | Only the current generation can deliver; one logical event            |
| Delete/archive page, remove token, or revoke page access  | No later reminder; no inaccessible page content in delivery           |
| In-app, email, and Slack preferences                      | Existing delivery choices honored; inbox links to the page            |
| Normal scheduler run                                      | Due in-app event appears within 15 minutes, with lag measured         |
| Schema deploy, missed token event, or stalled cron        | Reconciler/claim replay restores due rows without duplicate delivery  |
| Reminder PUT/DELETE with stale revision or wrong author   | Correct response/error; no other member's reminder exposed or changed |
