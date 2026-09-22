// @vitest-environment jsdom
import { BlockNoteEditor, type PartialBlock } from "@blocknote/core";
import { describe, expect, it } from "vitest";
import { notesCommentSchema } from "./mentions";
import { slackReplyBody } from "../worker/slack-thread-text";

describe("Slack comments in the NoteFlare editor", () => {
  it("loads converted quotes, code, links and verified mentions with the real comment schema", async () => {
    const body = await slackReplyBody(
      "Hello <@UONE> *bold*\n&gt; quoted text\n```\ncode &amp; text\n```\n<https://example.test|link>",
      async () => ({ id: "member-1", name: "One" }),
    );
    const editor = BlockNoteEditor.create({
      schema: notesCommentSchema,
      initialContent: body as PartialBlock<
        typeof notesCommentSchema.blockSchema,
        typeof notesCommentSchema.inlineContentSchema,
        typeof notesCommentSchema.styleSchema
      >[],
    });
    const document = JSON.stringify(editor.document);
    expect(document).toContain('"type":"quote"');
    expect(document).toContain('"type":"codeBlock"');
    expect(document).toContain('"entityId":"member-1"');
    expect(document).toContain('"href":"https://example.test"');
    expect(document).toContain('"bold":true');
    expect(document).toContain("code & text");
  });
});
