export type DateMention = {
  tokenId: string;
  revision: string;
  createdBy: string;
  kind: "all-day" | "timed";
  value: string;
  timezone: string;
};

export type ReminderChoice = "at_time" | "5m_before" | "1h_before" | "1d_before";

const CALENDAR_DATE = /^\d{4}-\d{2}-\d{2}$/;
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const calendarFormatters = new Map<string, Intl.DateTimeFormat>();

function calendarFormatter(timezone: string) {
  let formatter = calendarFormatters.get(timezone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US-u-ca-gregory", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    if (calendarFormatters.size >= 64) calendarFormatters.clear();
    calendarFormatters.set(timezone, formatter);
  }
  return formatter;
}

function calendarParts(instant: Date, timezone: string) {
  const parts = calendarFormatter(timezone).formatToParts(instant);
  const number = (type: string) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: number("year"),
    month: number("month"),
    day: number("day"),
    hour: number("hour"),
    minute: number("minute"),
  };
}

function calendarDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

export function validCalendarDate(value: string) {
  if (!CALENDAR_DATE.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).toISOString().slice(0, 10) === value;
}

export function validTimezone(value: string) {
  try {
    calendarFormatter(value);
    return true;
  } catch {
    return false;
  }
}

export function validDateMention(value: DateMention) {
  return Boolean(
    value.tokenId &&
    value.revision &&
    value.createdBy &&
    validTimezone(value.timezone) &&
    (value.kind === "all-day"
      ? validCalendarDate(value.value)
      : value.kind === "timed" &&
        !Number.isNaN(Date.parse(value.value)) &&
        new Date(value.value).toISOString() === value.value),
  );
}

export function dateMentionFromProps(props: Record<string, unknown>): DateMention | null {
  let candidate: unknown = props;
  if (typeof props.payload === "string" && props.payload) {
    try {
      candidate = JSON.parse(props.payload);
    } catch {
      return null;
    }
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return null;
  const record = candidate as Record<string, unknown>;
  if (
    typeof record.tokenId !== "string" ||
    typeof record.revision !== "string" ||
    typeof record.createdBy !== "string" ||
    (record.kind !== "all-day" && record.kind !== "timed") ||
    typeof record.value !== "string" ||
    typeof record.timezone !== "string"
  )
    return null;
  const mention: DateMention = {
    tokenId: record.tokenId,
    revision: record.revision,
    createdBy: record.createdBy,
    kind: record.kind,
    value: record.value,
    timezone: record.timezone,
  };
  return validDateMention(mention) ? mention : null;
}

export function readableDateMention(mention: DateMention) {
  if (!validDateMention(mention)) return "Date";
  if (mention.kind === "all-day") return mention.value;
  const wall = calendarParts(new Date(mention.value), mention.timezone);
  return `${calendarDate(wall.year, wall.month, wall.day)} ${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")} ${mention.timezone}`;
}

export function parseDatePhrase(query: string, now: Date, timezone: string): string | null {
  if (!validTimezone(timezone)) return null;
  const current = calendarParts(now, timezone);
  const base = new Date(Date.UTC(current.year, current.month - 1, current.day));
  const normalized = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (normalized === "today") return calendarDate(current.year, current.month, current.day);
  if (normalized === "tomorrow") base.setUTCDate(base.getUTCDate() + 1);
  else if (normalized === "next week") base.setUTCDate(base.getUTCDate() + ((8 - base.getUTCDay()) % 7 || 7));
  else if (normalized === "next month") {
    base.setUTCDate(1);
    base.setUTCMonth(base.getUTCMonth() + 1);
  } else if (normalized.startsWith("next ")) {
    const weekday = WEEKDAYS.indexOf(normalized.slice(5));
    if (weekday < 0) return null;
    base.setUTCDate(base.getUTCDate() + ((weekday - base.getUTCDay() + 7) % 7 || 7));
  } else {
    const amount = /^in (\d{1,3}) (day|days|week|weeks)$/.exec(normalized);
    if (!amount) return null;
    const days = Number(amount[1]) * (amount[2]!.startsWith("week") ? 7 : 1);
    if (days < 1 || days > 365) return null;
    base.setUTCDate(base.getUTCDate() + days);
  }
  return base.toISOString().slice(0, 10);
}

/** Earlier occurrence for a repeated time; first valid minute after a DST gap. */
export function resolveLocalDateTime(date: string, timezone: string, hour: number, minute: number): number | null {
  if (
    !validCalendarDate(date) ||
    !validTimezone(timezone) ||
    !Number.isInteger(hour) ||
    hour < 0 ||
    hour > 23 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  )
    return null;
  const [year, month, day] = date.split("-").map(Number);
  const target = Date.UTC(year!, month! - 1, day!, hour, minute);
  const offsets = new Set<number>();
  for (const delta of [-36, -12, 0, 12, 36]) {
    const instant = target + delta * 3_600_000;
    const wall = calendarParts(new Date(instant), timezone);
    offsets.add((Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute) - instant) / 60_000);
  }
  const matches = [...offsets]
    .map((offset) => target - offset * 60_000)
    .filter((instant) => {
      const wall = calendarParts(new Date(instant), timezone);
      return calendarDate(wall.year, wall.month, wall.day) === date && wall.hour === hour && wall.minute === minute;
    });
  if (matches.length) return Math.min(...matches);
  // A skipped local time has no exact instant. Find the first representable
  // minute after it, rather than silently moving backward across the gap.
  for (let instant = target - 18 * 3_600_000; instant <= target + 36 * 3_600_000; instant += 60_000) {
    const wall = calendarParts(new Date(instant), timezone);
    const wallMinute = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute);
    if (wallMinute >= target) return instant;
  }
  return null;
}

export function dateMentionDueAt(mention: DateMention, choice: ReminderChoice | { absolute: string }): number | null {
  if (!validDateMention(mention)) return null;
  if (typeof choice === "object") {
    const instant = Date.parse(choice.absolute);
    return Number.isFinite(instant) && new Date(instant).toISOString() === choice.absolute ? instant : null;
  }
  const atTime =
    mention.kind === "timed" ? Date.parse(mention.value) : resolveLocalDateTime(mention.value, mention.timezone, 9, 0);
  if (atTime === null) return null;
  if (choice === "1d_before") {
    const local = dateMentionLocalFields(mention);
    if (!local) return null;
    const previous = new Date(`${local.date}T12:00:00.000Z`);
    previous.setUTCDate(previous.getUTCDate() - 1);
    const [hour, minute] = local.time.split(":").map(Number);
    return resolveLocalDateTime(previous.toISOString().slice(0, 10), mention.timezone, hour!, minute!);
  }
  const offset = { at_time: 0, "5m_before": 300_000, "1h_before": 3_600_000 }[choice];
  return atTime - offset;
}

export function formatDateMention(mention: DateMention, locale?: string) {
  if (!validDateMention(mention)) return mention.value || "Date";
  return mention.kind === "all-day"
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone: "UTC" }).format(
        new Date(`${mention.value}T12:00:00Z`),
      )
    : new Intl.DateTimeFormat(locale, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
        timeZone: mention.timezone,
        timeZoneName: "short",
      }).format(new Date(mention.value));
}

export function dateMentionLocalFields(mention: DateMention) {
  if (!validDateMention(mention)) return null;
  if (mention.kind === "all-day") return { date: mention.value, time: "09:00" };
  const wall = calendarParts(new Date(mention.value), mention.timezone);
  return {
    date: calendarDate(wall.year, wall.month, wall.day),
    time: `${String(wall.hour).padStart(2, "0")}:${String(wall.minute).padStart(2, "0")}`,
  };
}
