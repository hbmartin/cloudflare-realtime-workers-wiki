import { MarkdownWriteError, parseWritableMarkdown } from "./notion-markdown-write";

export type MarkdownEdit = { from: number; to: number; text: string };
export type MarkdownCommand = {
  type: "replace_content" | "update_content" | "insert_content" | "replace_content_range";
  allowDeletingContent: boolean;
  edits: MarkdownEdit[];
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new MarkdownWriteError("Markdown command is invalid.");
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string) {
  if (typeof value !== "string") throw new MarkdownWriteError(`${name} must be a string.`);
  return value;
}

function matches(markdown: string, needle: string) {
  if (!needle) throw new MarkdownWriteError("A Markdown selection cannot be empty.");
  const positions: number[] = [];
  for (let index = markdown.indexOf(needle); index >= 0; index = markdown.indexOf(needle, index + needle.length)) {
    positions.push(index);
    if (positions.length > 1000) throw new MarkdownWriteError("Markdown selection has too many matches.");
  }
  return positions;
}

function selection(markdown: string, text: string): { from: number; to: number } {
  const ellipsis = text.indexOf("...");
  if (ellipsis < 0) {
    const found = matches(markdown, text);
    if (found.length !== 1) throw new MarkdownWriteError("Markdown selection is missing or ambiguous.");
    return { from: found[0]!, to: found[0]! + text.length };
  }
  const start = text.slice(0, ellipsis);
  const end = text.slice(ellipsis + 3);
  if (!start || !end || end.includes("...")) throw new MarkdownWriteError("Markdown range selection is invalid.");
  const ranges = matches(markdown, start).flatMap((from) => {
    const final = markdown.indexOf(end, from + start.length);
    return final < 0 ? [] : [{ from, to: final + end.length }];
  });
  if (ranges.length !== 1) throw new MarkdownWriteError("Markdown selection is missing or ambiguous.");
  return ranges[0]!;
}

function validateReplacement(text: string) {
  parseWritableMarkdown(text);
  return text;
}

/** Validate every command and resolve its selections against one projected revision. */
export function parseMarkdownCommand(input: unknown, markdown: string): MarkdownCommand {
  const body = object(input);
  const type = body.type;
  if (!["replace_content", "update_content", "insert_content", "replace_content_range"].includes(String(type)))
    throw new MarkdownWriteError("Markdown command type is invalid.");
  const command = object(body[String(type)]);
  const allowDeletingContent = command.allow_deleting_content === true;
  if (command.allow_deleting_content !== undefined && typeof command.allow_deleting_content !== "boolean")
    throw new MarkdownWriteError("allow_deleting_content must be a boolean.");
  let edits: MarkdownEdit[];
  if (type === "replace_content") {
    const text = string(command.new_str, "new_str");
    if (new TextEncoder().encode(text).length > 128 * 1024)
      throw new MarkdownWriteError("Markdown content exceeds 128 KiB.");
    edits = [{ from: 0, to: markdown.length, text }];
  } else if (type === "update_content") {
    const updates = command.content_updates;
    if (!Array.isArray(updates) || !updates.length || updates.length > 100)
      throw new MarkdownWriteError("content_updates must contain between 1 and 100 updates.");
    edits = updates.flatMap((raw) => {
      const update = object(raw);
      const oldStr = string(update.old_str, "old_str");
      const newStr = string(update.new_str, "new_str");
      const found = matches(markdown, oldStr);
      const replaceAll = update.replace_all_matches === true || command.replace_all_matches === true;
      if (!found.length || (found.length > 1 && !replaceAll))
        throw new MarkdownWriteError("An old_str is missing or ambiguous.");
      validateReplacement(newStr);
      return found.map((from) => ({ from, to: from + oldStr.length, text: newStr }));
    });
  } else if (type === "insert_content") {
    const content = validateReplacement(string(command.content, "content"));
    if (command.after !== undefined && command.position !== undefined)
      throw new MarkdownWriteError("after and position cannot be combined.");
    let at = markdown.length;
    if (command.after !== undefined) at = selection(markdown, string(command.after, "after")).to;
    else if (command.position !== undefined) {
      const position = object(command.position);
      if (position.type !== "start" && position.type !== "end")
        throw new MarkdownWriteError("position.type must be start or end.");
      if (position.type === "start") at = 0;
    }
    edits = [{ from: at, to: at, text: content }];
  } else {
    const range = selection(markdown, string(command.content_range, "content_range"));
    edits = [{ ...range, text: validateReplacement(string(command.content, "content")) }];
  }
  edits.sort((left, right) => left.from - right.from || left.to - right.to);
  for (let index = 1; index < edits.length; index += 1) {
    if (edits[index]!.from < edits[index - 1]!.to || edits[index]!.from === edits[index - 1]!.from)
      throw new MarkdownWriteError("Markdown updates overlap or repeat the same position.");
  }
  return { type: type as MarkdownCommand["type"], allowDeletingContent, edits };
}

export function applyMarkdownEdits(markdown: string, edits: MarkdownEdit[]) {
  let result = markdown;
  for (const edit of edits.toReversed()) result = result.slice(0, edit.from) + edit.text + result.slice(edit.to);
  return result;
}
