import type { Task } from "../shared/tasks";
import { TASK_STATUS_LABELS } from "../shared/tasks";
import type { Notification } from "../shared/types";
import type { SearchResponse } from "../shared/types";
import type { MentionCursor } from "./mentions-inbox";

export function safeSlackText(value: string, max = 3000) {
  return value
    .slice(0, max)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "¦");
}

const plain = (text: string) => ({ type: "plain_text", text: text.slice(0, 150) });
const button = (actionId: string, label: string, value: string) => ({
  type: "button",
  action_id: actionId,
  text: plain(label),
  value,
});

export function threadRootBlocks(input: {
  heading: string;
  body: string;
  url: string;
  linkId: string;
  resolved: boolean;
  muted: boolean;
  shareActive: boolean;
  shareEligible: boolean;
}) {
  const actions = [
    button(
      input.resolved ? "noteflare_thread_reopen" : "noteflare_thread_resolve",
      input.resolved ? "Reopen" : "Resolve",
      input.linkId,
    ),
    button("noteflare_page_watch", "Watch", input.linkId),
    button("noteflare_page_unwatch", "Unwatch", input.linkId),
    button(
      input.muted ? "noteflare_mapping_unmute" : "noteflare_mapping_mute",
      input.muted ? "Unmute" : "Mute",
      input.linkId,
    ),
    {
      type: "static_select",
      action_id: "noteflare_mapping_snooze",
      placeholder: plain("Snooze"),
      options: [1, 8, 24].map((hours) => ({
        text: plain(`${hours} hour${hours === 1 ? "" : "s"}`),
        value: `${input.linkId}:${hours}`,
      })),
    },
    ...(input.shareEligible
      ? [
          button(
            input.shareActive ? "noteflare_share_view" : "noteflare_share_create",
            input.shareActive ? "View share" : "Create share",
            input.linkId,
          ),
        ]
      : []),
  ];
  return [
    { type: "section", text: { type: "mrkdwn", verbatim: true, text: input.heading.slice(0, 3000) } },
    { type: "section", text: { type: "mrkdwn", verbatim: true, text: input.body.slice(0, 3000) } },
    { type: "context", elements: [{ type: "mrkdwn", verbatim: true, text: `<${input.url}|Open in NoteFlare>` }] },
    { type: "actions", elements: actions },
  ];
}

export function unfurlBlocks(input: { title: string; excerpt: string; referenceId: string; shareActive: boolean }) {
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        verbatim: true,
        text: `*${safeSlackText(input.title, 200)}*\n${safeSlackText(input.excerpt, 240)}`,
      },
    },
    {
      type: "actions",
      elements: [
        button(
          input.shareActive ? "noteflare_unfurl_share_view" : "noteflare_unfurl_share_create",
          input.shareActive ? "View public share" : "Create public share",
          input.referenceId,
        ),
      ],
    },
  ];
}

export type SearchModalFilters = {
  query: string;
  spaceId?: string;
  tagIds?: string[];
  kind?: string;
  archive?: string;
  offset: number;
};

export function searchModal(
  sessionId: string,
  filters: SearchModalFilters,
  origin: string,
  result?: SearchResponse,
  error?: string,
  revision = 0,
) {
  const filterBlocks: unknown[] = [
    {
      type: "input",
      block_id: "query",
      optional: true,
      label: plain("Query"),
      element: { type: "plain_text_input", action_id: "value", max_length: 200, initial_value: filters.query },
    },
    {
      type: "input",
      block_id: "space",
      optional: true,
      label: plain("Space"),
      element: {
        type: "external_select",
        action_id: "value",
        min_query_length: 0,
        placeholder: plain("Any accessible space"),
        ...(filters.spaceId ? { initial_option: { text: plain(filters.spaceId), value: filters.spaceId } } : {}),
      },
    },
    {
      type: "input",
      block_id: "tags",
      optional: true,
      label: plain("Tags"),
      element: {
        type: "multi_external_select",
        action_id: "value",
        min_query_length: 0,
        max_selected_items: 20,
        placeholder: plain("Any tag"),
        ...(filters.tagIds?.length
          ? { initial_options: filters.tagIds.map((id) => ({ text: plain(id), value: id })) }
          : {}),
      },
    },
    {
      type: "input",
      block_id: "kind",
      optional: true,
      label: plain("Page kind"),
      element: {
        type: "static_select",
        action_id: "value",
        placeholder: plain("Any kind"),
        options: ["document", "table", "diagram"].map((kind) => ({ text: plain(kind), value: kind })),
        ...(filters.kind ? { initial_option: { text: plain(filters.kind), value: filters.kind } } : {}),
      },
    },
    {
      type: "input",
      block_id: "archive",
      optional: true,
      label: plain("Archive state"),
      element: {
        type: "static_select",
        action_id: "value",
        placeholder: plain("Active"),
        options: ["active", "archived", "all"].map((archive) => ({ text: plain(archive), value: archive })),
        ...(filters.archive ? { initial_option: { text: plain(filters.archive), value: filters.archive } } : {}),
      },
    },
    { type: "actions", block_id: "search_action", elements: [button("noteflare_search_run", "Search", sessionId)] },
  ];
  const resultBlocks: unknown[] = error
    ? [{ type: "section", text: { type: "mrkdwn", text: safeSlackText(error, 300) } }]
    : result
      ? result.results.length
        ? result.results.map((item) => ({
            type: "section",
            text: {
              type: "mrkdwn",
              verbatim: true,
              text: `*<${origin}/?page=${encodeURIComponent(item.page.id)}|${safeSlackText(item.page.title, 180)}>* · ${safeSlackText(item.space.name, 100)}\n${safeSlackText(item.snippet.text, 240)}`,
            },
          }))
        : [{ type: "section", text: { type: "plain_text", text: "No accessible pages matched." } }]
      : [
          {
            type: "section",
            text: {
              type: "plain_text",
              text: "Searching… If results do not load, close this modal and reopen /notes.",
            },
          },
        ];
  const nav =
    result && (filters.offset > 0 || result.hasMore)
      ? [
          {
            type: "actions",
            block_id: "search_navigation",
            elements: [
              ...(filters.offset > 0 ? [button("noteflare_search_previous", "Previous", sessionId)] : []),
              ...(result.hasMore ? [button("noteflare_search_next", "Next", sessionId)] : []),
            ],
          },
        ]
      : [];
  return {
    type: "modal",
    callback_id: "noteflare_search",
    private_metadata: `${sessionId}:${revision}`,
    title: plain("Search NoteFlare"),
    close: plain("Close"),
    submit: plain("Done"),
    blocks: [...filterBlocks, ...resultBlocks, ...nav],
  };
}

export function homeView(input: {
  tasks?: Task[];
  notifications?: Notification[];
  sessionId: string;
  mentions: Array<{
    page: { id: string; title: string };
    excerpt: string;
    unread: boolean;
    actorName: string | null;
    spaceName: string;
  }>;
  firstPage: boolean;
  nextCursor: MentionCursor | null;
  origin: string;
  unavailable?: boolean;
}) {
  if (input.unavailable)
    return {
      type: "home",
      private_metadata: input.sessionId,
      blocks: [
        {
          type: "section",
          text: {
            type: "plain_text",
            text: "Your NoteFlare inbox is unavailable. Connect your account in NoteFlare Settings.",
          },
        },
      ],
    };
  const blocks: unknown[] = [
    { type: "header", text: plain("Inbox") },
    {
      type: "actions",
      elements: [
        button("noteflare_my_tasks", "My Tasks", "first"),
        button("noteflare_compose_page", "Create page", input.sessionId),
        button("noteflare_compose_task", "Create task", input.sessionId),
      ],
    },
  ];
  for (const item of input.notifications ?? [])
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        verbatim: true,
        text: `${item.readAt ? "" : "*● Unread* · "}${safeSlackText(item.actor?.name ?? "A collaborator", 80)} · ${safeSlackText(item.eventType.replaceAll("_", " "), 50)}
<${input.origin}/?page=${encodeURIComponent(item.page.id)}|${safeSlackText(item.page.title, 160)}>`,
      },
    });
  blocks.push({ type: "section", text: { type: "mrkdwn", text: "*Pages mentioning you*" } });
  for (const item of input.mentions) {
    const url = `${input.origin}/?page=${encodeURIComponent(item.page.id)}`;
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        verbatim: true,
        text: `${item.unread ? "*● Unread* · " : ""}${safeSlackText(item.actorName ?? "A collaborator", 100)} mentioned you in *<${url}|${safeSlackText(item.page.title, 150)}>* · ${safeSlackText(item.spaceName, 100)}\n${safeSlackText(item.excerpt, 250)}`,
      },
    });
  }
  if (!input.mentions.length)
    blocks.push({ type: "section", text: { type: "plain_text", text: "No accessible mentions on this page." } });
  blocks.push({
    type: "actions",
    elements: [
      ...(!input.firstPage ? [button("noteflare_home_previous", "Previous", input.sessionId)] : []),
      ...(input.nextCursor ? [button("noteflare_home_next", "Next", input.sessionId)] : []),
      button("noteflare_home_read", "Mark inbox read", input.sessionId),
    ],
  });
  blocks.push({ type: "header", text: plain("My Tasks") });
  for (const task of input.tasks ?? [])
    blocks.push({
      type: "section",
      text: {
        type: "mrkdwn",
        verbatim: true,
        text: `<${input.origin}/?page=${encodeURIComponent(task.detailPageId)}|${safeSlackText(task.title, 160)}> · ${TASK_STATUS_LABELS[task.status]}${task.dueDate ? ` · ${task.dueDate}` : ""}`,
      },
      ...(task.editable ? { accessory: button("noteflare_edit_task", "Edit task", task.id) } : {}),
    });
  if (!input.tasks?.length) blocks.push({ type: "section", text: { type: "plain_text", text: "No assigned tasks." } });
  return { type: "home", private_metadata: input.sessionId, blocks };
}
