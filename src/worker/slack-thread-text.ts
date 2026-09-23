import type { CommentBody, ProseMirrorJson } from "../shared/types";
import { HttpError } from "./http";

type CommentNode = Omit<ProseMirrorJson, "content"> & {
  content?: CommentNode[];
  props?: Record<string, unknown>;
  styles?: Record<string, unknown>;
  href?: string;
  children?: CommentNode[];
};

type Mention = { id: string; name: string };
const decode = (value: string) =>
  value.replace(/&(?:amp|lt|gt);/g, (entity) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">" })[entity]!);
export const escapeSlackText = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

// Only recognized Slack tokens become structured nodes. HTML and broadcasts stay text.
export async function slackReplyBody(
  text: string,
  resolve: (id: string) => Promise<{ id: string; name: string } | null>,
): Promise<CommentBody> {
  if (new TextEncoder().encode(text).length > 16 * 1024)
    throw new HttpError(413, "slack_comment_too_large", "Reply is too large.");
  const mentions = new Map<string, Mention | null>();
  const ids = [...new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map((match) => match[1]!))];
  if (ids.length > 50) throw new HttpError(422, "slack_comment_too_complex", "Reply has too many mentions.");
  for (const id of ids) mentions.set(id, await resolve(id));
  let nodes = 0;
  function inline(value: string, depth = 0): CommentNode[] {
    if (depth > 8) return [{ type: "text", text: decode(value), styles: {} }];
    const result: CommentNode[] = [];
    const tokens = /(`[^`\n]+`|<[^>\n]+>|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g;
    let offset = 0;
    const literal = (v: string) => {
      if (v) result.push({ type: "text", text: decode(v), styles: {} });
    };
    for (const match of value.matchAll(tokens)) {
      const token = match[0];
      if (["*", "_", "~"].includes(token[0]!)) {
        const before = value[match.index! - 1] ?? "";
        const after = value[match.index! + token.length] ?? "";
        if ((before && !/[\s([{]/.test(before)) || (after && !/[\s.,!?;:)\]}]/.test(after))) {
          literal(value.slice(offset, match.index! + 1));
          result.push(...inline(token.slice(1, -1), depth + 1));
          literal(token.at(-1)!);
          offset = match.index! + token.length;
          continue;
        }
      }
      literal(value.slice(offset, match.index));
      const mention = /^<@([UW][A-Z0-9]+)>$/.exec(token);
      if (mention) {
        const member = mentions.get(mention[1]!);
        result.push(
          member
            ? { type: "mention", props: { entityType: "user", entityId: member.id, label: member.name } }
            : { type: "text", text: "@Slack member", styles: {} },
        );
      } else if (token.startsWith("<")) {
        const [url, ...label] = token.slice(1, -1).split("|");
        let safe = false;
        try {
          safe = ["http:", "https:"].includes(new URL(decode(url!)).protocol);
        } catch {
          /* Plain text fallback. */
        }
        if (safe)
          result.push({
            type: "link",
            href: decode(url!),
            content: [{ type: "text", text: decode(label.join("|") || url!), styles: {} }],
          });
        else literal(label.join("|") || token);
      } else {
        const style = token[0] === "`" ? "code" : token[0] === "*" ? "bold" : token[0] === "_" ? "italic" : "strike";
        const children =
          style === "code"
            ? [{ type: "text", text: decode(token.slice(1, -1)), styles: {} }]
            : inline(token.slice(1, -1), depth + 1);
        for (const child of children)
          result.push(
            child.type === "text"
              ? { ...child, styles: { ...(child.styles as Record<string, unknown>), [style]: true } }
              : child,
          );
      }
      offset = match.index + token.length;
    }
    literal(value.slice(offset));
    const merged: CommentNode[] = [];
    for (const node of result) {
      const previous = merged.at(-1);
      if (
        previous?.type === "text" &&
        node.type === "text" &&
        JSON.stringify(previous.styles ?? {}) === JSON.stringify(node.styles ?? {})
      )
        previous.text = (previous.text ?? "") + (node.text ?? "");
      else merged.push(node);
    }
    nodes += merged.length;
    if (nodes > 300) throw new HttpError(422, "slack_comment_too_complex", "Reply is too complex.");
    return merged;
  }
  const blocks: CommentNode[] = [];
  const segments = text.split(/(```[\s\S]*?```)/g);
  for (const segment of segments) {
    if (segment.startsWith("```") && segment.endsWith("```")) {
      blocks.push({
        type: "codeBlock",
        props: { language: "text" },
        content: [{ type: "text", text: decode(segment.slice(3, -3).replace(/^\n/, "")), styles: {} }],
        children: [],
      });
    } else {
      for (const line of segment.split("\n")) {
        if (blocks.length > 200) throw new HttpError(422, "slack_comment_too_complex", "Reply has too many lines.");
        const quote = /^(?:>|&gt;)\s?/.test(line);
        blocks.push({
          type: quote ? "quote" : "paragraph",
          props: {},
          content: inline(quote ? line.replace(/^(?:>|&gt;)\s?/, "") : line),
          children: [],
        });
      }
    }
  }
  return blocks;
}

export async function slackCommentText(body: CommentBody, resolve: (id: string) => Promise<string | null>) {
  const identities = new Map<string, string | null>();
  let visited = 0;
  async function render(node: unknown): Promise<string> {
    if (++visited > 2000) return "";
    if (Array.isArray(node)) {
      const parts: string[] = [];
      for (const child of node) parts.push(await render(child));
      return parts.join("");
    }
    if (!node || typeof node !== "object") return "";
    const n = node as Record<string, unknown>;
    if (n.type === "mention") {
      const attrs = (n.props ?? n.attrs ?? {}) as Record<string, unknown>;
      const id = typeof attrs.entityId === "string" ? attrs.entityId : "";
      if (attrs.entityType === "user" && id) {
        if (!identities.has(id)) identities.set(id, await resolve(id));
        const slackId = identities.get(id);
        if (slackId && /^[UW][A-Z0-9]+$/.test(slackId)) return `<@${slackId}>`;
      }
      return escapeSlackText(`@${typeof attrs.label === "string" ? attrs.label : "Member"}`);
    }
    if (n.type === "link") {
      const href = typeof n.href === "string" ? n.href : "";
      const label = (await render(n.content)).replaceAll("|", "¦");
      try {
        const url = new URL(href);
        if (["http:", "https:"].includes(url.protocol))
          return `<${escapeSlackText(url.toString().replaceAll("|", "%7C"))}|${label}>`;
      } catch {
        // A malformed stored link remains safe, readable text.
      }
      return label;
    }
    if (typeof n.text === "string") return escapeSlackText(n.text);
    const content = await render(n.content);
    const children = await render(n.children);
    return content + (n.type === "paragraph" || n.type === "quote" || n.type === "codeBlock" ? "\n" : "") + children;
  }
  // Escape before truncating; don't cut a live Slack mention or entity in half.
  const rendered = (await render(body)).trim();
  if (rendered.length <= 2800) return rendered;
  let end = 2700;
  // A cut inside a Slack token or HTML entity changes how the remaining text is read.
  for (const token of rendered.matchAll(/<[^>]*>|&(?:amp|lt|gt);/g)) {
    const start = token.index!;
    if (start < end && start + token[0].length > end) {
      end = start;
      break;
    }
  }
  return rendered.slice(0, end) + "…";
}
