import { describe, expect, it } from "vitest";
import { calendarDay, moveCalendarDate } from "./table-calendar";
describe("calendar timestamp semantics", () => {
  it("keeps date-only values independent of display timezone", () => {
    expect(calendarDay("2026-03-01", "America/Los_Angeles")).toBe("2026-03-01");
    expect(calendarDay("2026-03-01T01:00:00Z", "America/Los_Angeles")).toBe("2026-02-28");
  });
  it("retains local time, fractional seconds and fixed offset during a day drag", () => {
    expect(moveCalendarDate("2026-03-01T15:30:00.125+05:30", "2026-04-01")).toBe("2026-04-01T15:30:00.125+05:30");
    expect(moveCalendarDate("2026-10-02T00:30:00+09:00", "2026-11-01")).toBe("2026-11-01T00:30:00+09:00");
    expect(moveCalendarDate("2026-10-02T01:00:00Z", "2026-11-01")).toBe("2026-11-01T01:00:00Z");
    expect(moveCalendarDate("2026-10-02T01:00:00Z", "2026-11-01", undefined, "America/Los_Angeles")).toBe(
      "2026-11-02T01:00:00Z",
    );
  });
  it("preserves wall clock time under the property's zone across DST", () => {
    expect(moveCalendarDate("2026-03-07T15:30:00-05:00", "2026-03-08", "America/New_York")).toBe(
      "2026-03-08T15:30:00-04:00",
    );
    expect(() => moveCalendarDate("2026-03-07T02:30:00-05:00", "2026-03-08", "America/New_York")).toThrow(
      "does not exist",
    );
  });
  it("allows unscheduling without replacing the date with a fabricated timestamp", () => {
    expect(moveCalendarDate("2026-03-01T15:00:00Z", null)).toBeNull();
    expect(moveCalendarDate(null, "2026-03-01")).toBe("2026-03-01");
  });
  it("lands fixed-offset timestamps on the viewer's chosen day across month boundaries", () => {
    const moved = moveCalendarDate("2026-10-02T00:15:00.125+09:00", "2026-11-01", undefined, "America/Los_Angeles");
    expect(moved).toBe("2026-11-02T00:15:00.125+09:00");
    expect(calendarDay(moved, "America/Los_Angeles")).toBe("2026-11-01");
    const extreme = moveCalendarDate("2026-10-01T23:30:00-12:00", "2026-11-01", undefined, "Pacific/Kiritimati");
    expect(extreme).toBe("2026-10-30T23:30:00-12:00");
    expect(calendarDay(extreme, "Pacific/Kiritimati")).toBe("2026-11-01");
  });
  it("preserves the property's original clock across DST for a different viewer zone", () => {
    const moved = moveCalendarDate("2026-03-07T15:30:00.125-05:00", "2026-03-09", "America/New_York", "Asia/Tokyo");
    expect(moved).toBe("2026-03-08T15:30:00.125-04:00");
    expect(calendarDay(moved, "Asia/Tokyo")).toBe("2026-03-09");
    expect(() => moveCalendarDate("2026-03-01T15:00:00Z", "2026-03-02", undefined, "Unknown/Zone")).toThrow(
      "Invalid time zone",
    );
  });
});
