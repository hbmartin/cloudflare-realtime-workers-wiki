import { Schema, Slice } from "prosemirror-model";
import { describe, expect, it } from "vitest";
import { dateMentionFromProps } from "../shared/date-mentions";
import { regeneratePastedDateMentions } from "./date-mention-paste";

const schema = new Schema({
  nodes: {
    doc: { content: "block+" },
    paragraph: { content: "inline*", group: "block" },
    text: { group: "inline" },
    dateMention: { inline: true, group: "inline", atom: true, attrs: { payload: { default: "" } } },
  },
});

describe("pasted date mentions", () => {
  it("gives each pasted token a new identity owned by the pasting member", () => {
    const payload = JSON.stringify({
      tokenId: "original",
      revision: "revision-1",
      createdBy: "other-member",
      kind: "all-day",
      value: "2026-10-01",
      timezone: "America/Chicago",
    });
    const paragraph = schema.nodes.paragraph!.create(null, [
      schema.nodes.dateMention!.create({ payload }),
      schema.text(" and "),
      schema.nodes.dateMention!.create({ payload }),
    ]);
    const pasted = regeneratePastedDateMentions(new Slice(paragraph.content, 0, 0), "current-member");
    const mentions = pasted.content.content
      .filter((node) => node.type.name === "dateMention")
      .map((node) => dateMentionFromProps(node.attrs)!);
    expect(mentions).toHaveLength(2);
    expect(new Set(mentions.map((mention) => mention.tokenId)).size).toBe(2);
    expect(mentions.every((mention) => mention.tokenId !== "original" && mention.createdBy === "current-member")).toBe(
      true,
    );
    expect(mentions.map((mention) => mention.value)).toEqual(["2026-10-01", "2026-10-01"]);
  });
});
