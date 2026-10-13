/** Date-only values are calendar dates; timestamps are instants displayed in the viewer's zone. */
export function calendarDay(value: unknown, timeZone: string): string | null {
  if (typeof value !== "string" || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function validateCalendarZone(value: unknown): string {
  if (typeof value !== "string" || value.length > 100) throw new Error("Choose a valid display timezone.");
  Intl.DateTimeFormat("en", { timeZone: value }).resolvedOptions();
  return value;
}

/** Preserve the source clock while landing on the selected day in the viewer's zone. */
export function moveCalendarDate(
  previous: unknown,
  target: unknown,
  propertyZone?: string,
  displayZone?: string,
): string | null {
  if (displayZone !== undefined) validateCalendarZone(displayZone);
  if (target === null) return null;
  if (
    typeof target !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(target) ||
    new Date(`${target}T00:00:00Z`).toISOString().slice(0, 10) !== target
  )
    throw new Error("Choose a valid calendar day.");
  if (typeof previous !== "string" || !previous.includes("T")) return target;
  const instant = new Date(previous);
  if (!Number.isFinite(instant.getTime())) throw new Error("The existing timestamp is invalid.");
  if (!propertyZone && displayZone === undefined) return `${target}${previous.slice(10)}`;
  if (propertyZone) validateCalendarZone(propertyZone);
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: propertyZone ?? "UTC",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const wallTime = (date: Date) => {
    const parts = formatter.formatToParts(date);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)!.value;
    return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}:${part("second")}`;
  };
  const clock = wallTime(instant).slice(10),
    fraction = /\.\d+/.exec(previous)?.[0] ?? "",
    targetDay = Date.parse(`${target}T00:00:00Z`),
    preferredDay =
      displayZone === undefined
        ? targetDay
        : Date.parse(`${propertyZone ? wallTime(instant).slice(0, 10) : previous.slice(0, 10)}T00:00:00Z`) +
          targetDay -
          Date.parse(`${calendarDay(previous, displayZone)}T00:00:00Z`);
  // Try the original source/viewer day relationship first, then account for offset changes.
  for (const delta of displayZone === undefined ? [0] : [0, -1, 1, -2, 2]) {
    const day = new Date(preferredDay + delta * 86400000).toISOString().slice(0, 10);
    let value = `${day}${previous.slice(10)}`;
    if (propertyZone) {
      const desired = `${day}${clock}`,
        desiredUtc = Date.parse(`${desired}Z`);
      let candidate = desiredUtc;
      for (let iteration = 0; iteration < 4; iteration++)
        candidate += desiredUtc - Date.parse(`${wallTime(new Date(candidate))}Z`);
      if (wallTime(new Date(candidate)) !== desired) continue;
      const offset = Math.round((desiredUtc - candidate) / 60000),
        sign = offset >= 0 ? "+" : "-",
        magnitude = Math.abs(offset);
      const suffix = `${sign}${String(Math.floor(magnitude / 60)).padStart(2, "0")}:${String(magnitude % 60).padStart(2, "0")}`;
      value = `${desired}${fraction}${suffix}`;
    }
    if (displayZone === undefined || calendarDay(value, displayZone) === target) return value;
  }
  throw new Error("This local time does not exist on the selected day. Choose another time.");
}
