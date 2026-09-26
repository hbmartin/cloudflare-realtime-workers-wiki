import { describe, expect, it } from "vitest";
import { slackLabel } from "./slack-blocks";

describe("Slack labels", () => {
  it("keeps labels at the 75-code-point limit unchanged", () => {
    const label = "a".repeat(75);
    expect(slackLabel(label)).toBe(label);
  });

  it("truncates Unicode labels to 74 code points plus an ellipsis", () => {
    const label = "😀".repeat(76);
    const truncated = slackLabel(label);
    expect(Array.from(truncated)).toHaveLength(75);
    expect(truncated).toBe(`${"😀".repeat(74)}…`);
    expect(truncated.endsWith("\ud83d")).toBe(false);
  });
});
