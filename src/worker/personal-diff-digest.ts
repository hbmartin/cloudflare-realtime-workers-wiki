import { comparisonLines, comparisonUrl, digestComparison, type ChangeCheckpoint } from "./document-changes";
import { digestExcerpts } from "../shared/block-diff";
import type { Env } from "./env";

export type DigestRow = {
  id: string;
  user_id: string;
  workspace_id: string;
  page_id: string;
  page_title: string;
  event_type: string;
  data_json: string;
  actor_name: string | null;
};
const escape = (value: string) =>
  value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
const slackEscape = (value: string) =>
  value.replace(
    /[&<>|*_~`]/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "|": "¦", "*": "∗", _: "＿", "~": "～", "`": "ˋ" })[char]!,
  );
function boundedSlack(value: string, max: number) {
  let output = "";
  for (const char of value) {
    const escaped = slackEscape(char);
    if (output.length + escaped.length > max) break;
    output += escaped;
  }
  return output;
}
export async function composePersonalDigest(
  env: Env,
  rows: DigestRow[],
  channel: "email" | "slack",
  token: string,
  copy: (row: DigestRow) => string,
  cutoff?: number,
) {
  const deliveryRows = await env.DB.prepare(
    `SELECT outbox_id,comparison_json FROM deliveries WHERE outbox_id IN (SELECT value FROM json_each(?)) AND channel=? AND claim_token=?`,
  )
    .bind(JSON.stringify(rows.map((row) => `outbox:${row.id}`)), channel, token)
    .all<{ outbox_id: string; comparison_json: string | null }>();
  const frozen = new Map(deliveryRows.results.map((row) => [row.outbox_id.slice(7), row.comparison_json]));
  const groups = new Map<string, DigestRow[]>();
  for (const row of rows) {
    const key =
      row.event_type === "page_edit" && row.id.startsWith("change:")
        ? `${row.page_id}:${frozen.get(row.id) ?? "new"}`
        : row.id;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  const rendered: {
    row: DigestRow;
    lines: string[];
    href: string;
    links: { label: string; href: string }[];
    comparison: boolean;
  }[] = [];
  for (const group of groups.values()) {
    const row = group[0]!;
    const lines: string[] = [];
    const links: { label: string; href: string }[] = [];
    let isComparison = false;
    let href = `${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(row.page_id)}`;
    if (row.event_type === "page_edit") {
      let pair: { first: string; last: string } | null = frozen.get(row.id) ? JSON.parse(frozen.get(row.id)!) : null;
      if (!pair) {
        const ids = group.flatMap((item) => {
          try {
            const value: unknown = JSON.parse(item.data_json).checkpointId;
            return typeof value === "string" ? [value] : [];
          } catch {
            return [];
          }
        });
        const checkpoints =
          cutoff !== undefined && row.id.startsWith("change:")
            ? await env.DB.prepare(`WITH eligible AS (SELECT c.* FROM page_change_checkpoints c JOIN page_change_recipients r ON r.checkpoint_id=c.id
              WHERE c.page_id=? AND r.user_id=? AND r.${channel === "email" ? "emailed_at" : "slack_at"} IS NULL AND c.created_at<?
              ) SELECT * FROM eligible WHERE id IN (
                SELECT id FROM (SELECT id FROM eligible ORDER BY created_at,content_epoch,sequence LIMIT 1)
                UNION ALL SELECT id FROM (SELECT id FROM eligible ORDER BY created_at DESC,content_epoch DESC,sequence DESC LIMIT 1)
              ) ORDER BY created_at,content_epoch,sequence`)
                .bind(row.page_id, row.user_id, cutoff)
                .all<ChangeCheckpoint>()
            : await env.DB.prepare(
                `SELECT * FROM page_change_checkpoints WHERE page_id=? AND id IN (SELECT value FROM json_each(?)) ORDER BY created_at,content_epoch,sequence`,
              )
                .bind(row.page_id, JSON.stringify(ids))
                .all<ChangeCheckpoint>();
        pair = { first: checkpoints.results[0]?.id ?? "", last: checkpoints.results.at(-1)?.id ?? "" };
        await env.DB.prepare(`UPDATE deliveries SET comparison_json=COALESCE(comparison_json,?)
          WHERE outbox_id IN (SELECT value FROM json_each(?)) AND channel=? AND status='pending' AND claim_token=?`)
          .bind(JSON.stringify(pair), JSON.stringify(group.map((item) => `outbox:${item.id}`)), channel, token)
          .run();
      }
      if (pair.first && pair.last) {
        const comparison = await digestComparison(env, row.page_id, pair.first, pair.last);
        lines.push(...comparisonLines(comparison));
        if (!comparison.diff) lines.push(copy(row));
        if (comparison.diff)
          for (const change of digestExcerpts(comparison.diff))
            if (change.kind !== "removed")
              links.push({
                label: `Open ${change.kind} block`,
                href: `${env.BETTER_AUTH_URL}/?page=${encodeURIComponent(row.page_id)}#block=${encodeURIComponent(change.id)}`,
              });
        isComparison = true;
        href = comparisonUrl(env.BETTER_AUTH_URL, row.page_id, pair);
      } else lines.push(copy(row));
    } else {
      lines.push(copy(row));
    }
    rendered.push({ row, lines, href, links, comparison: isComparison });
  }
  const text: string[] = ["Your daily NoteFlare digest:"],
    html: string[] = ["<p>Your daily NoteFlare digest:</p>"];
  let count = 0;
  let firstPageId: string | null = null;
  const budget = Math.min(2700, Math.floor(35000 / Math.max(1, rendered.length)));
  const accessible =
    await env.DB.prepare(`SELECT p.id,p.title,p.kind FROM pages p JOIN workspace_members m ON m.workspace_id=p.workspace_id AND m.user_id=?
      JOIN spaces s ON s.id=p.space_id LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=m.user_id
      WHERE p.id IN (SELECT value FROM json_each(?)) AND p.workspace_id=? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0
      AND (m.role='owner' OR s.visibility='workspace' OR sm.user_id IS NOT NULL)`)
      .bind(rows[0]!.user_id, JSON.stringify(rendered.map((item) => item.row.page_id)), rows[0]!.workspace_id)
      .all<{ id: string; title: string; kind: string }>();

  const titles = new Map(accessible.results.map((page) => [page.id, page]));
  for (const { row, lines, href, links, comparison } of rendered) {
    const available = titles.get(row.page_id);
    if (!available) continue;
    if (row.event_type === "page_edit" && available.kind === "document" && !comparison)
      lines.unshift("Comparison unavailable; exact history was not retained for this change.");
    count++;
    firstPageId ??= row.page_id;
    let section = `${Array.from(available.title).slice(0, 120).join("")}\n${lines.join("\n")}\n${href}\n${links.map((link) => link.href).join("\n")}`;
    if (channel === "slack") {
      section = slackEscape(section);
      if (section.length > budget) {
        const title = boundedSlack(available.title, 120),
          url = slackEscape(href);
        const summary = boundedSlack(
          lines[0] ?? "Updated this page.",
          Math.max(0, budget - title.length - url.length - 3),
        );
        section = `${title}\n${summary}\n${url}`;
      }
    }
    text.push(section);
    html.push(
      `<section><h3><a href="${escape(href)}">${escape(available.title)}</a></h3>${lines.map((line) => `<p>${escape(line)}</p>`).join("")}<a href="${escape(href)}">${comparison ? "Open comparison" : "Open page"}</a>${links.map((link) => `<p><a href="${escape(link.href)}">${escape(link.label)}</a></p>`).join("")}</section>`,
    );
  }
  const body = text.join("\n\n");
  return {
    empty: count === 0,
    pageId: firstPageId,
    text: body,
    html: html.join(""),
    slackSections:
      channel === "slack" && (rendered.some((item) => item.comparison) || body.length > 2700) ? text : undefined,
  };
}
