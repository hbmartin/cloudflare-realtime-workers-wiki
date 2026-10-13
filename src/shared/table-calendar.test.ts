import { describe, expect, it } from "vitest";
import { calendarDay, moveCalendarDate } from "./table-calendar";
describe("calendar timestamp semantics", () => {
  it("keeps date-only values independent of display timezone", () => {
    expect(calendarDay("2026-03-01", "America/Los_Angeles")).toBe("2026-03-01");
    expect(calendarDay("2026-03-01T01:00:00Z", "America/Los_Angeles")).toBe("2026-02-28");
  });
  it("retains local time, fractional seconds and fixed offset during a day drag", () => {
    expect(moveCalendarDate("2026-03-01T15:30:00.125+05:30", "2026-04-01")).toBe("2026-04-01T15:30:00.125+05:30");
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
});
