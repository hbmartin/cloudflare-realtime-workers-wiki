import { describe, expect, it } from "vitest";
import {
  dateMentionDueAt,
  dateMentionFromProps,
  formatDateMention,
  parseDatePhrase,
  resolveLocalDateTime,
  validCalendarDate,
} from "./date-mentions";

describe("date mentions", () => {
  it("resolves supported phrases in the member timezone", () => {
    const now = new Date("2026-09-29T02:00:00.000Z");
    expect(parseDatePhrase("today", now, "America/Chicago")).toBe("2026-09-28");
    expect(parseDatePhrase("tomorrow", now, "America/Chicago")).toBe("2026-09-29");
    expect(parseDatePhrase("next monday", now, "America/Chicago")).toBe("2026-10-05");
    expect(parseDatePhrase("next week", now, "America/Chicago")).toBe("2026-10-05");
    expect(parseDatePhrase("next month", now, "America/Chicago")).toBe("2026-10-01");
    expect(parseDatePhrase("in 2 weeks", now, "America/Chicago")).toBe("2026-10-12");
    expect(parseDatePhrase("in 400 days", now, "America/Chicago")).toBeNull();
    expect(parseDatePhrase("Oct 10", now, "America/Chicago")).toBe("2026-10-10");
    expect(parseDatePhrase("Sep 10", now, "America/Chicago")).toBe("2027-09-10");
    expect(parseDatePhrase("Feb 29, 2027", now, "America/Chicago")).toBeNull();
  });

  it("rejects invalid calendar dates", () => {
    expect(validCalendarDate("2026-02-29")).toBe(false);
    expect(validCalendarDate("2028-02-29")).toBe(true);
  });

  it("advances through a DST gap and chooses the earlier repeated time", () => {
    expect(new Date(resolveLocalDateTime("2026-03-08", "America/Chicago", 2, 30)!).toISOString()).toBe(
      "2026-03-08T08:00:00.000Z",
    );
    expect(new Date(resolveLocalDateTime("2026-11-01", "America/Chicago", 1, 30)!).toISOString()).toBe(
      "2026-11-01T06:30:00.000Z",
    );
  });

  it("uses 09:00 in the stored timezone for all-day reminders", () => {
    const mention = {
      tokenId: "token",
      revision: "revision",
      createdBy: "author",
      kind: "all-day" as const,
      value: "2026-11-01",
      timezone: "America/Chicago",
    };
    expect(new Date(dateMentionDueAt(mention, "at_time")!).toISOString()).toBe("2026-11-01T15:00:00.000Z");
    expect(new Date(dateMentionDueAt(mention, "1d_before")!).toISOString()).toBe("2026-10-31T14:00:00.000Z");
  });

  it("keeps the stored local hour for a timed day-before reminder across DST", () => {
    const mention = {
      tokenId: "token",
      revision: "revision",
      createdBy: "author",
      kind: "timed" as const,
      value: "2026-11-01T15:00:00.000Z",
      timezone: "America/Chicago",
    };
    expect(new Date(dateMentionDueAt(mention, "1d_before")!).toISOString()).toBe("2026-10-31T14:00:00.000Z");
  });

  it("reads one atomic payload and rejects a broken combined value", () => {
    const mention = {
      tokenId: "token",
      revision: "revision",
      createdBy: "author",
      kind: "timed" as const,
      value: "2026-10-01T14:00:00.000Z",
      timezone: "America/Chicago",
    };
    expect(dateMentionFromProps({ payload: JSON.stringify(mention) })).toEqual(mention);
    expect(dateMentionFromProps({ payload: JSON.stringify({ ...mention, value: "2026-10-01" }) })).toBeNull();
  });

  it("shows timed dates in their stored timezone with the viewer's locale", () => {
    expect(
      formatDateMention(
        {
          tokenId: "token",
          revision: "revision",
          createdBy: "author",
          kind: "timed",
          value: "2026-10-01T14:00:00.000Z",
          timezone: "America/Chicago",
        },
        "en-US",
      ),
    ).toMatch(/Oct 1, 2026.*9:00 AM.*CDT/);
  });
});
