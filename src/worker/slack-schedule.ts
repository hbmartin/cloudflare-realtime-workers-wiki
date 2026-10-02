import { resolveLocalDateTime, validTimezone } from "../shared/date-mentions";
import type { Env } from "./env";
import { HttpError } from "./http";
import type { SlackApiContracts } from "./slack";
export type SlackChannel = SlackApiContracts["conversations.info"]["output"]["channel"];
export function channelInvalidReason(channel: SlackChannel | undefined): string | null {
  if (!channel) return "channel_not_found";
  if (channel.is_im || channel.is_mpim || (!channel.is_channel && !channel.is_group)) return "unsupported_channel_type";
  if (channel.is_shared || channel.is_ext_shared || channel.is_org_shared || channel.pending_shared?.length)
    return "shared_channel";
  if (channel.is_archived) return "is_archived";
  if (!channel.is_member) return "not_in_channel";
  return null;
}
function dateInZone(timestamp: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const fields = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${fields.year}-${fields.month}-${fields.day}`;
}
function adjacentDate(date: string, delta: number) {
  return new Date(Date.parse(`${date}T12:00:00Z`) + delta * 86400_000).toISOString().slice(0, 10);
}
export function digestWindow(timestamp: number, time: string, timezone: string) {
  if (!validTimezone(timezone) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time))
    throw new HttpError(422, "invalid_digest_schedule", "Choose a valid daily time and IANA timezone.");
  const [hour, minute] = time.split(":").map(Number);
  let date = dateInZone(timestamp, timezone);
  let end = resolveLocalDateTime(date, timezone, hour!, minute!)!;
  if (end > timestamp) {
    date = adjacentDate(date, -1);
    end = resolveLocalDateTime(date, timezone, hour!, minute!)!;
  }
  return {
    start: resolveLocalDateTime(adjacentDate(date, -1), timezone, hour!, minute!)!,
    end,
    next: resolveLocalDateTime(adjacentDate(date, 1), timezone, hour!, minute!)!,
  };
}
export function defaultDigestTimezone(env: Env) {
  const zone = env.SLACK_DIGEST_DEFAULT_TIMEZONE;
  if (!zone || !validTimezone(zone))
    throw new HttpError(
      409,
      "slack_timezone_not_configured",
      "The operator must configure SLACK_DIGEST_DEFAULT_TIMEZONE with an IANA timezone.",
    );
  return zone;
}
