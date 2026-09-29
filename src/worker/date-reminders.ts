import { dateMentionDueAt, type ReminderChoice } from "../shared/date-mentions";
import { dateTokens, type ProseMirrorJson } from "../shared/document-projection";
import type { DocumentContentEnvelope } from "../shared/types";
import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { notificationFanoutStatements } from "./notifications";
import { correlationHeaders, logger, recordMetric } from "./observability";
import type { PageRow } from "./page-access";

type ReminderRow = {
  id: string;
  workspace_id: string;
  page_id: string;
  content_epoch: number;
  token_id: string;
  user_id: string;
  token_revision: string;
  timezone: string;
  choice_json: string;
  due_at: number;
  generation: number;
  state: "active" | "claimed" | "delivered" | "canceled";
  claim_id: string | null;
  claimed_at: number | null;
  delivery_receipt_id: string | null;
  checked_at: number;
};

const ACTIVE_SWEEP_INTERVAL = 15 * 60_000;
const DELIVERED_SWEEP_INTERVAL = 24 * 60 * 60_000;
const NEXT_SWEEP_SQL = `checked_at + CASE WHEN state='delivered' THEN ${DELIVERED_SWEEP_INTERVAL} ELSE ${ACTIVE_SWEEP_INTERVAL} END`;

export type ReminderInput = { revision: string; choice: ReminderChoice | { absolute: string } };

function reminderChoice(value: unknown): ReminderChoice | { absolute: string } | null {
  if (["at_time", "5m_before", "1h_before", "1d_before"].includes(String(value))) return value as ReminderChoice;
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).absolute === "string" &&
    Object.keys(value).length === 1
  )
    return { absolute: (value as { absolute: string }).absolute };
  return null;
}

export function parseReminderInput(value: Record<string, unknown>): ReminderInput {
  const choice = reminderChoice(value.choice);
  if (typeof value.revision !== "string" || !value.revision || value.revision.length > 100 || !choice)
    throw new HttpError(422, "invalid_reminder", "Choose a valid reminder for the current date.");
  return { revision: value.revision, choice };
}

async function roomDocument(env: Env, pageId: string, epoch: number) {
  const response = await env.DOCUMENT.getByName(`${pageId}~${epoch}`).fetch(
    new Request("https://document.internal/content", {
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
    }),
  );
  if (!response.ok) throw new HttpError(503, "content_unavailable", "Page content is temporarily unavailable.");
  const envelope = await response.json<DocumentContentEnvelope>();
  if (envelope.pageId !== pageId || envelope.contentEpoch !== epoch || envelope.document.type !== "doc")
    throw new HttpError(503, "content_unavailable", "Page content is temporarily unavailable.");
  return envelope.document;
}

async function pageDateToken(env: Env, page: Pick<PageRow, "id" | "content_epoch">, tokenId: string) {
  const tokens = dateTokens(await roomDocument(env, page.id, page.content_epoch));
  return tokens.get(tokenId) ?? null;
}

function reminderJson(row: ReminderRow) {
  return {
    id: row.id,
    tokenId: row.token_id,
    revision: row.token_revision,
    choice: reminderChoice(JSON.parse(row.choice_json)),
    dueAt: row.due_at,
    generation: row.generation,
    state: row.state,
  };
}

export async function getDateReminder(env: Env, member: MemberContext, page: PageRow, tokenId: string) {
  const row = await env.DB.prepare(
    `SELECT * FROM date_reminders WHERE page_id=? AND workspace_id=? AND token_id=? AND user_id=? AND state!='canceled'`,
  )
    .bind(page.id, member.workspace.id, tokenId, member.user.id)
    .first<ReminderRow>();
  return row ? reminderJson(row) : null;
}

export async function putDateReminder(
  env: Env,
  member: MemberContext,
  page: PageRow,
  tokenId: string,
  input: ReminderInput,
) {
  const token = await pageDateToken(env, page, tokenId);
  if (!token || token.createdBy !== member.user.id)
    throw new HttpError(404, "date_token_not_found", "Date token not found.");
  if (token.revision !== input.revision)
    throw new HttpError(409, "date_token_changed", "This date changed. Reopen the reminder and try again.");
  const dueAt = dateMentionDueAt(token, input.choice);
  if (dueAt === null || dueAt <= Date.now())
    throw new HttpError(422, "reminder_in_past", "Choose a future reminder time.");
  const timestamp = Date.now();
  const row = await env.DB.prepare(
    `INSERT INTO date_reminders
      (id,workspace_id,page_id,content_epoch,token_id,user_id,token_revision,timezone,choice_json,
       due_at,generation,state,checked_at,created_at,updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,1,'active',?,?,?)
     ON CONFLICT(page_id,token_id,user_id) DO UPDATE SET
       content_epoch=excluded.content_epoch,token_revision=excluded.token_revision,
       timezone=excluded.timezone,choice_json=excluded.choice_json,due_at=excluded.due_at,
       generation=date_reminders.generation+1,state='active',claim_id=NULL,claimed_at=NULL,
       delivery_receipt_id=NULL,checked_at=excluded.checked_at,updated_at=excluded.updated_at
     WHERE date_reminders.content_epoch!=excluded.content_epoch
        OR date_reminders.token_revision!=excluded.token_revision
        OR date_reminders.choice_json!=excluded.choice_json
        OR date_reminders.due_at!=excluded.due_at
        OR date_reminders.state!='active'
     RETURNING *`,
  )
    .bind(
      crypto.randomUUID(),
      member.workspace.id,
      page.id,
      page.content_epoch,
      tokenId,
      member.user.id,
      token.revision,
      token.timezone,
      JSON.stringify(input.choice),
      dueAt,
      timestamp,
      timestamp,
      timestamp,
    )
    .first<ReminderRow>();
  const savedRow =
    row ??
    (await env.DB.prepare(`SELECT * FROM date_reminders WHERE page_id=? AND token_id=? AND user_id=?`)
      .bind(page.id, tokenId, member.user.id)
      .first<ReminderRow>());
  if (!savedRow) throw new HttpError(503, "reminder_unavailable", "Reminder could not be saved.");
  const latestDocument = await roomDocument(env, page.id, page.content_epoch);
  const latestToken = dateTokens(latestDocument).get(tokenId);
  if (!latestToken || latestToken.revision !== token.revision || latestToken.createdBy !== member.user.id) {
    await reconcileDateRemindersForPage(env, page.id, page.content_epoch, latestDocument);
    const effective = await env.DB.prepare(`SELECT * FROM date_reminders WHERE id=?`)
      .bind(savedRow.id)
      .first<ReminderRow>();
    if (effective?.state === "active" && latestToken?.createdBy === member.user.id) return reminderJson(effective);
    throw new HttpError(409, "date_token_changed", "This date changed. Reopen the reminder and try again.");
  }
  return reminderJson(savedRow);
}

export async function deleteDateReminder(env: Env, member: MemberContext, page: PageRow, tokenId: string) {
  const deleted = await env.DB.prepare(
    `UPDATE date_reminders SET state='canceled',generation=generation+1,claim_id=NULL,claimed_at=NULL,
       delivery_receipt_id=NULL,updated_at=?
     WHERE page_id=? AND workspace_id=? AND token_id=? AND user_id=? AND state!='canceled'
     RETURNING id`,
  )
    .bind(Date.now(), page.id, member.workspace.id, tokenId, member.user.id)
    .first<{ id: string }>();
  if (!deleted) throw new HttpError(404, "date_reminder_not_found", "Reminder not found.");
}

export async function reconcileDateRemindersForPage(
  env: Env,
  pageId: string,
  epoch: number,
  document: ProseMirrorJson,
  sequence?: number,
  sweepCutoff?: { active: number; delivered: number },
) {
  const rows = await env.DB.prepare(
    `SELECT * FROM date_reminders WHERE page_id=? AND content_epoch=? AND state IN ('active','claimed','delivered')
      ${sweepCutoff === undefined ? "" : `AND ((state IN ('active','claimed') AND checked_at<?) OR (state='delivered' AND checked_at<?)) ORDER BY ${NEXT_SWEEP_SQL} LIMIT 25`}`,
  )
    .bind(pageId, epoch, ...(sweepCutoff === undefined ? [] : [sweepCutoff.active, sweepCutoff.delivered]))
    .all<ReminderRow>();
  if (!rows.results.length) return;
  const tokens = dateTokens(document);
  const timestamp = Date.now();
  const unchangedIds: string[] = [];
  for (const row of rows.results) {
    const token = tokens.get(row.token_id);
    const choice = reminderChoice(JSON.parse(row.choice_json));
    const dueAt = token && choice ? dateMentionDueAt(token, choice) : null;
    const sameToken = token && token.createdBy === row.user_id && dueAt !== null && row.content_epoch === epoch;
    const unchanged =
      sameToken && token.revision === row.token_revision && token.timezone === row.timezone && dueAt === row.due_at;
    const sequenceGuard =
      sequence === undefined
        ? ""
        : `AND EXISTS (SELECT 1 FROM document_projections
      WHERE page_id=date_reminders.page_id AND content_epoch=date_reminders.content_epoch AND sequence=?)`;
    if (!sameToken || (!unchanged && dueAt !== row.due_at && dueAt <= timestamp)) {
      await env.DB.prepare(
        `UPDATE date_reminders SET state='canceled',generation=generation+1,claim_id=NULL,claimed_at=NULL,
           delivery_receipt_id=NULL,checked_at=?,updated_at=?
         WHERE id=? AND generation=? AND state IN ('active','claimed','delivered') ${sequenceGuard}`,
      )
        .bind(timestamp, timestamp, row.id, row.generation, ...(sequence === undefined ? [] : [sequence]))
        .run();
    } else if (!unchanged && dueAt === row.due_at) {
      await env.DB.prepare(
        `UPDATE date_reminders SET token_revision=?,timezone=?,checked_at=?,updated_at=?
         WHERE id=? AND generation=? AND state IN ('active','claimed','delivered') ${sequenceGuard}`,
      )
        .bind(
          token.revision,
          token.timezone,
          timestamp,
          timestamp,
          row.id,
          row.generation,
          ...(sequence === undefined ? [] : [sequence]),
        )
        .run();
    } else if (!unchanged) {
      await env.DB.prepare(
        `UPDATE date_reminders SET token_revision=?,timezone=?,due_at=?,generation=generation+1,
           state='active',claim_id=NULL,claimed_at=NULL,delivery_receipt_id=NULL,checked_at=?,updated_at=?
         WHERE id=? AND generation=? AND state IN ('active','claimed','delivered') ${sequenceGuard}`,
      )
        .bind(
          token.revision,
          token.timezone,
          dueAt,
          timestamp,
          timestamp,
          row.id,
          row.generation,
          ...(sequence === undefined ? [] : [sequence]),
        )
        .run();
    } else {
      unchangedIds.push(row.id);
    }
  }
  if (unchangedIds.length) {
    const sequenceGuard =
      sequence === undefined
        ? ""
        : `AND EXISTS (SELECT 1 FROM document_projections
      WHERE page_id=date_reminders.page_id AND content_epoch=date_reminders.content_epoch AND sequence=?)`;
    await env.DB.prepare(
      `UPDATE date_reminders SET checked_at=? WHERE id IN (SELECT value FROM json_each(?)) ${sequenceGuard}`,
    )
      .bind(timestamp, JSON.stringify(unchangedIds), ...(sequence === undefined ? [] : [sequence]))
      .run();
  }
}

async function sweepDateReminders(env: Env) {
  const timestamp = Date.now();
  const cutoffs = { active: timestamp - ACTIVE_SWEEP_INTERVAL, delivered: timestamp - DELIVERED_SWEEP_INTERVAL };
  const rows = await env.DB.prepare(
    `SELECT page_id,content_epoch,
       MIN(${NEXT_SWEEP_SQL}) next_check FROM date_reminders
       WHERE (state IN ('active','claimed') AND checked_at<?)
          OR (state='delivered' AND checked_at<?)
       GROUP BY page_id,content_epoch ORDER BY next_check LIMIT 5`,
  )
    .bind(cutoffs.active, cutoffs.delivered)
    .all<{ page_id: string; content_epoch: number }>();
  const failures: unknown[] = [];
  for (const row of rows.results) {
    try {
      const page = await env.DB.prepare(`SELECT content_epoch FROM pages WHERE id=? AND archived_at IS NULL`)
        .bind(row.page_id)
        .first<{ content_epoch: number }>();
      if (!page || page.content_epoch !== row.content_epoch) {
        await env.DB.prepare(
          `UPDATE date_reminders SET state='canceled',generation=generation+1,updated_at=?
           WHERE page_id=? AND content_epoch=? AND state IN ('active','claimed','delivered')`,
        )
          .bind(Date.now(), row.page_id, row.content_epoch)
          .run();
        continue;
      }
      await reconcileDateRemindersForPage(
        env,
        row.page_id,
        row.content_epoch,
        await roomDocument(env, row.page_id, row.content_epoch),
        undefined,
        cutoffs,
      );
    } catch (error) {
      failures.push(error);
      logger.error(
        "date_reminder.sweep.failed",
        "scheduler",
        "Date reminder reconciliation failed.",
        { pageId: row.page_id, epoch: row.content_epoch },
        error,
      );
      // Rotate a persistently unavailable room out of this bounded scan so
      // other pages still receive reconciliation on the next tick.
      await env.DB.prepare(
        `UPDATE date_reminders SET checked_at=? WHERE page_id=? AND content_epoch=?
           AND state IN ('active','claimed','delivered')`,
      )
        .bind(Date.now(), row.page_id, row.content_epoch)
        .run()
        .catch((rotateError) => {
          failures.push(rotateError);
          logger.error(
            "date_reminder.sweep_rotate.failed",
            "scheduler",
            "Reminder sweep rotation failed.",
            { pageId: row.page_id },
            rotateError,
          );
        });
    }
  }
  if (failures.length) throw new AggregateError(failures, "Date reminder sweep failed.");
}

async function deliverDueDateReminders(env: Env) {
  const timestamp = Date.now();
  const due = await env.DB.prepare(
    `SELECT id FROM date_reminders WHERE due_at<=? AND
       (state='active' OR (state='claimed' AND claimed_at<?))
     ORDER BY due_at,id LIMIT 100`,
  )
    .bind(timestamp, timestamp - 2 * 60_000)
    .all<{ id: string }>();
  for (const { id } of due.results) {
    const claimId = crypto.randomUUID();
    const row = await env.DB.prepare(
      `UPDATE date_reminders SET state='claimed',claim_id=?,claimed_at=?,updated_at=?
       WHERE id=? AND due_at<=? AND (state='active' OR (state='claimed' AND claimed_at<?))
       RETURNING *`,
    )
      .bind(claimId, timestamp, timestamp, id, timestamp, timestamp - 2 * 60_000)
      .first<ReminderRow>();
    if (!row) continue;
    try {
      const page = await env.DB.prepare(
        `SELECT p.space_id,p.content_epoch FROM pages p
          JOIN spaces s ON s.id=p.space_id AND s.workspace_id=p.workspace_id
          JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=?
          LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=?
         WHERE p.id=? AND p.workspace_id=? AND p.content_epoch=?
           AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0
           AND (wm.role='owner' OR s.visibility='workspace' OR sm.user_id IS NOT NULL)`,
      )
        .bind(row.user_id, row.user_id, row.page_id, row.workspace_id, row.content_epoch)
        .first<{ space_id: string; content_epoch: number }>();
      if (!page) {
        await env.DB.prepare(
          `UPDATE date_reminders SET state='canceled',generation=generation+1,claim_id=NULL,
             claimed_at=NULL,checked_at=?,updated_at=?
           WHERE id=? AND generation=? AND state='claimed' AND claim_id=?`,
        )
          .bind(timestamp, timestamp, row.id, row.generation, claimId)
          .run();
        continue;
      }
      const document = await roomDocument(env, row.page_id, row.content_epoch);
      const token = dateTokens(document).get(row.token_id);
      const choice = reminderChoice(JSON.parse(row.choice_json));
      if (!token || token.createdBy !== row.user_id || !choice || dateMentionDueAt(token, choice) !== row.due_at) {
        await reconcileDateRemindersForPage(env, row.page_id, row.content_epoch, document);
        continue;
      }
      const receiptId = `${row.id}:${row.generation}`;
      const results = await env.DB.batch([
        env.DB.prepare(
          `UPDATE date_reminders SET state='delivered',delivery_receipt_id=?,token_revision=?,claim_id=NULL,
             claimed_at=NULL,checked_at=?,updated_at=?
           WHERE id=? AND generation=? AND state='claimed' AND claim_id=?`,
        ).bind(receiptId, token.revision, timestamp, timestamp, row.id, row.generation, claimId),
        ...notificationFanoutStatements(env.DB, {
          workspaceId: row.workspace_id,
          spaceId: page.space_id,
          pageId: row.page_id,
          contentEpoch: row.content_epoch,
          threadId: null,
          actorId: null,
          eventType: "reminder",
          sourceId: receiptId,
          recipientIds: [row.user_id],
          emitSlackChannel: false,
          reminderGuard: { id: row.id, generation: row.generation, receiptId },
          data: { tokenId: row.token_id, dueAt: row.due_at },
          createdAt: timestamp,
        }),
      ]);
      if (results[0]?.meta.changes && !results[1]?.meta.changes) {
        await env.DB.prepare(
          `UPDATE date_reminders SET state='canceled',generation=generation+1,
             delivery_receipt_id=NULL,updated_at=?
           WHERE id=? AND generation=? AND state='delivered' AND delivery_receipt_id=?`,
        )
          .bind(timestamp, row.id, row.generation, receiptId)
          .run();
      }
      if (results[1]?.meta.changes) {
        recordMetric(env, {
          event: "date_reminder.delivery",
          component: "scheduler",
          operation: "fanout",
          outcome: "delivered",
          lagMs: Math.max(0, timestamp - row.due_at),
        });
      }
    } catch (error) {
      logger.error("date_reminder.delivery.failed", "scheduler", "Date reminder delivery failed.", { id }, error);
      await env.DB.prepare(
        `UPDATE date_reminders SET state='active',claim_id=NULL,claimed_at=NULL,updated_at=?
         WHERE id=? AND generation=? AND state='claimed' AND claim_id=?`,
      )
        .bind(Date.now(), row.id, row.generation, claimId)
        .run();
    }
  }
  const oldest = await env.DB.prepare(
    `SELECT MIN(due_at) due_at,COUNT(*) count FROM date_reminders WHERE state IN ('active','claimed') AND due_at<=?`,
  )
    .bind(Date.now())
    .first<{ due_at: number | null; count: number }>();
  recordMetric(env, {
    event: "date_reminder.backlog",
    component: "scheduler",
    operation: "due_scan",
    lagMs: oldest?.due_at === null || oldest?.due_at === undefined ? 0 : Math.max(0, Date.now() - oldest.due_at),
    backlog: oldest?.count ?? 0,
  });
}

export async function processDueDateReminders(env: Env) {
  let deliveryFailed = false;
  let deliveryFailure: unknown;
  try {
    await deliverDueDateReminders(env);
  } catch (error) {
    deliveryFailed = true;
    deliveryFailure = error;
  }
  try {
    await sweepDateReminders(env);
  } catch (error) {
    if (deliveryFailed)
      throw new AggregateError([deliveryFailure, error], "Date reminder delivery and sweep failed.", {
        cause: error,
      });
    throw error;
  }
  if (deliveryFailed) throw deliveryFailure;
}
