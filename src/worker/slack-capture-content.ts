import { HttpError } from "./http";
import type { SlackHistoryMessage } from "./slack";

export const MAX_CAPTURE_MESSAGES = 2_000;
export const MAX_CAPTURE_MARKDOWN_BYTES = 2 * 1024 * 1024;
const MARKDOWN_SPECIAL = new Set([
  "\\",
  "`",
  "*",
  "_",
  "{",
  "}",
  "[",
  "]",
  "(",
  ")",
  "#",
  "+",
  ".",
  "!",
  "|",
  ">",
  "~",
  "-",
]);

function escapeMarkdown(value: string) {
  return value.replace(/[\s\S]/gu, (character) => (MARKDOWN_SPECIAL.has(character) ? `\\${character}` : character));
}

function slackEntity(value: string) {
  return value.replace(/&(?:amp|lt|gt);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity]!);
}

function safeHttpsLink(value: string, slackOnly = false) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    if (slackOnly && !(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function link(label: string, href: string) {
  return `[${escapeMarkdown(label)}](<${href.replaceAll(">", "%3E")}>)`;
}

function messageText(value: string) {
  const pieces: string[] = [];
  let offset = 0;
  for (const match of value.matchAll(/<([^>\n]+)>/g)) {
    pieces.push(escapeMarkdown(slackEntity(value.slice(offset, match.index))));
    const token = match[1]!;
    if (token.startsWith("@")) pieces.push("@Slack member");
    else if (token.startsWith("#")) pieces.push(escapeMarkdown(`#${token.split("|")[1] ?? "channel"}`));
    else if (token.startsWith("!")) pieces.push(escapeMarkdown(`@${token.split("|")[1] ?? "Slack group"}`));
    else {
      const [address, label] = token.split("|", 2);
      const href = safeHttpsLink(slackEntity(address ?? ""));
      pieces.push(href ? link(slackEntity(label ?? address ?? ""), href) : escapeMarkdown(slackEntity(label ?? token)));
    }
    offset = match.index! + match[0].length;
  }
  pieces.push(escapeMarkdown(slackEntity(value.slice(offset))));
  return pieces.join("").trim();
}

export function captureMarkdown(input: {
  title: string;
  description?: string;
  permalink: string;
  capturedAt: number;
  messages: readonly SlackHistoryMessage[];
}) {
  if (input.messages.length === 0 || input.messages.length > MAX_CAPTURE_MESSAGES)
    throw new HttpError(422, "thread_too_large", "This thread exceeds the capture limit of 2,000 messages.");
  const permalink = safeHttpsLink(input.permalink, true);
  if (!permalink) throw new HttpError(422, "slack_source", "The Slack source link is unavailable.");
  const lines = [`# ${escapeMarkdown(input.title)}`, ""];
  if (input.description?.trim()) lines.push("## Description", "", escapeMarkdown(input.description.trim()), "");
  lines.push(
    "## Slack source",
    "",
    `Captured from Slack on ${new Date(input.capturedAt).toISOString()}. ${link("View source", permalink)}`,
  );
  for (const message of input.messages) {
    if (!/^\d{1,16}\.\d{1,16}$/.test(message.ts))
      throw new HttpError(422, "slack_source", "A Slack message timestamp is invalid.");
    lines.push("", `### ${escapeMarkdown(message.user ?? message.bot_id ?? "Slack member")} · ${message.ts}`, "");
    lines.push(messageText(message.text ?? ""));
    for (const reaction of message.reactions ?? []) {
      if (typeof reaction.name !== "string") continue;
      const name = reaction.name.trim();
      if (name && !/\s/.test(name) && Number.isSafeInteger(reaction.count) && reaction.count! > 0)
        lines.push("", `Reaction: ${escapeMarkdown(name)} × ${reaction.count}`);
    }
    for (const file of message.files ?? []) {
      const name = file.title?.trim() || file.name?.trim() || "Slack attachment";
      const href = safeHttpsLink(file.permalink ?? "", true);
      lines.push("", href ? `Attachment: ${link(name, href)}` : `Attachment: ${escapeMarkdown(name)}`);
    }
    for (const attachment of message.attachments ?? []) {
      const name = attachment.title?.trim() || "Slack attachment";
      const href = safeHttpsLink(attachment.title_link ?? "");
      lines.push("", href ? `Attachment: ${link(name, href)}` : `Attachment: ${escapeMarkdown(name)}`);
    }
  }
  const markdown = lines.join("\n").trimEnd() + "\n";
  if (new TextEncoder().encode(markdown).length > MAX_CAPTURE_MARKDOWN_BYTES)
    throw new HttpError(413, "thread_too_large", "This capture exceeds the 2 MiB content limit.");
  return markdown;
}
