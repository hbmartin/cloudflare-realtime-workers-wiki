import { AsyncLocalStorage } from "node:async_hooks";
import {
  boundedLogString,
  errorLogFields,
  LOG_IDENTIFIER_LIMIT,
  LOG_STACK_LIMIT,
  LOG_TEXT_LIMIT,
  PERSISTED_ERROR_MESSAGE_LIMIT,
  TRUNCATION_MARKER,
  rawSafeErrorMessage,
  wellFormedPrefix,
} from "../shared/error-log.ts";
import type { Env } from "./env";

export const OBSERVABILITY_SCHEMA = "notes.observability.v1";

export type ObservabilityTrigger = "fetch" | "scheduled" | "queue" | "workflow" | "durable-object";

export interface ObservabilityContext {
  requestId?: string;
  correlationId?: string;
  rayId?: string;
  trigger: ObservabilityTrigger;
  versionId?: string;
  versionTag?: string;
  metricRouteTemplate?: string;
}

type LogLevel = "debug" | "info" | "warn" | "error";
type LogFields = Readonly<Record<string, unknown>>;

const contextStorage = new AsyncLocalStorage<ObservabilityContext>();
const SENSITIVE_KEY = /authorization|cookie|password|secret|token|body|content|payload|email/i;
const AUTHORIZATION_LABEL = String.raw`(?:[A-Za-z0-9]+[-_])*(?:proxy[-_]?)?authorization(?:[-_]?header)?`;
const SERIALIZED_QUOTE = String.raw`\\*["']`;
const AUTHORIZATION_VALUE_WRAPPERS = String.raw`(?:(?:${SERIALIZED_QUOTE}|[\[({])[ \t]*)*`;
const BEARER_VALUE_WHITESPACE = String.raw`\s`;
const ASCII_WORD_CHARACTER = String.raw`[A-Za-z0-9_]`;
const UNLABELED_BEARER_BOUNDARY = String.raw`(?<!${ASCII_WORD_CHARACTER})`;
const AUTHORIZATION_LABEL_VALUE = new RegExp(String.raw`^${AUTHORIZATION_LABEL}$`, "i");
// These case-insensitive boundary patterns deliberately omit `u`: with `iu`, long s and Kelvin sign fold into
// ASCII word characters.
const LABELED_AUTHORIZATION_PREFIX = new RegExp(
  String.raw`(?<![A-Za-z0-9])${AUTHORIZATION_LABEL}(?:${SERIALIZED_QUOTE})?(?:[ \t]*(?::|=>|=|,)[ \t]*|[ \t]+)(${AUTHORIZATION_VALUE_WRAPPERS})(?:Basic[ \t]+|Bearer${BEARER_VALUE_WHITESPACE}+)`,
  "gi",
);
const BASIC_TOKEN_CHARACTER = String.raw`[A-Za-z0-9+/_=-]`;
const BEARER_TOKEN_CHARACTER = String.raw`[A-Za-z0-9._~+/=-]`;
const BASIC_VALUE_PREFIX = /\bBasic[ \t]+/gi;
// Keep this non-`u` for the same Unicode simple-fold boundary behavior described above.
const BEARER_VALUE_PREFIX = new RegExp(String.raw`${UNLABELED_BEARER_BOUNDARY}Bearer${BEARER_VALUE_WHITESPACE}+`, "gi");
const BASIC_TOKEN_CHARACTER_VALUE = new RegExp(String.raw`^${BASIC_TOKEN_CHARACTER}$`);
const BEARER_TOKEN_CHARACTER_VALUE = new RegExp(String.raw`^${BEARER_TOKEN_CHARACTER}$`);
const PARTIAL_BASIC_VALUE = new RegExp(
  String.raw`\bBasic[ \t]+(${AUTHORIZATION_VALUE_WRAPPERS})(${BASIC_TOKEN_CHARACTER}+)$`,
  "i",
);
const URL_QUERY = /(https?:\/\/[^\s?#]+)[?#][^\s]*/g;
const GENERIC_SECRET_PREFIXES = ["sk_", "crn_", "ghp_", "github_pat_", "secret_"] as const;
const XOX_SECRET_PREFIXES = ["xoxb-", "xoxa-", "xoxp-", "xoxr-", "xoxs-"] as const;
const SECRET_PREFIXES = [...GENERIC_SECRET_PREFIXES, ...XOX_SECRET_PREFIXES] as const;
const SECRET_PREFIX_MAX_LENGTH = Math.max(...SECRET_PREFIXES.map((prefix) => prefix.length));
const SECRET_VALUE = new RegExp(
  String.raw`\b(?:(?:${GENERIC_SECRET_PREFIXES.join("|")})[A-Za-z0-9_-]{8,}|(?:${XOX_SECRET_PREFIXES.join("|")})[A-Za-z0-9-]{8,})\b`,
  "gi",
);
const NESTED_VALUE_BUDGET = 100;
const REDACTED_VALUE = "[redacted]";
const OMITTED_ENTRIES = "[entries omitted]";
const OMITTED_VALUE = "[value omitted]";
const PROPERTY_OMITTED = "[property omitted]";
const DEPTH_OMITTED = "[depth omitted]";
const CIRCULAR_VALUE = "[circular]";
const OBJECT_OMITTED = "[object omitted]";
const EMPTY_KEY = "[empty key]";
const FUNCTION_OMITTED = "[function omitted]";
const SYMBOL_OMITTED = "[symbol omitted]";
/** @internal Exported so focused tests cover every production sanitization marker. */
export const ATOMIC_SANITIZATION_MARKERS = [
  REDACTED_VALUE,
  "[redacted-email]",
  "[redacted-secret]",
  TRUNCATION_MARKER,
  OMITTED_ENTRIES,
  OMITTED_VALUE,
  PROPERTY_OMITTED,
  DEPTH_OMITTED,
  CIRCULAR_VALUE,
  OBJECT_OMITTED,
  EMPTY_KEY,
  FUNCTION_OMITTED,
  SYMBOL_OMITTED,
] as const;
const SANITIZATION_MARKER_FIRST_CHARACTERS = new Set(ATOMIC_SANITIZATION_MARKERS.map((marker) => marker.charAt(0)));
const RESERVED_LOG_FIELDS = new Set([
  "schema",
  "event",
  "severity",
  "component",
  "message",
  "trigger",
  "requestId",
  "correlationId",
  "rayId",
  "versionId",
  "versionTag",
]);

function versionContext(env: Env) {
  const metadata = env.CF_VERSION_METADATA;
  return {
    ...(metadata?.id ? { versionId: metadata.id } : {}),
    ...(metadata?.tag ? { versionTag: metadata.tag } : {}),
  };
}

export function withObservabilityContext<T>(
  env: Env,
  context: Omit<ObservabilityContext, "versionId" | "versionTag">,
  callback: () => T,
) {
  return contextStorage.run({ ...context, ...versionContext(env) }, callback);
}

export function currentObservabilityContext() {
  return contextStorage.getStore();
}

export function setMetricRouteTemplate(template: string) {
  const context = currentObservabilityContext();
  if (context) context.metricRouteTemplate = template || "/unmatched";
}

export function metricRouteTemplate() {
  return currentObservabilityContext()?.metricRouteTemplate ?? "/unmatched";
}

export function correlationHeaders(): Record<string, string> {
  const context = currentObservabilityContext();
  const correlationId = context?.correlationId ?? context?.requestId;
  return correlationId ? { "x-request-id": correlationId } : {};
}

export function withDurableObjectContext<T>(env: Env, request: Request, callback: () => T) {
  const correlationId = request.headers.get("x-request-id") ?? undefined;
  return withObservabilityContext(
    env,
    {
      trigger: "durable-object",
      ...(correlationId ? { requestId: correlationId, correlationId } : {}),
    },
    callback,
  );
}

function isAsciiLetter(code: number) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

function isAsciiDigit(code: number) {
  return code >= 48 && code <= 57;
}

function isAsciiWord(code: number) {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 95;
}

function isEmailLocal(code: number) {
  return isAsciiLetter(code) || isAsciiDigit(code) || "._%+-".includes(String.fromCharCode(code));
}

function isEmailDomain(code: number) {
  return isAsciiLetter(code) || isAsciiDigit(code) || code === 46 || code === 45;
}

function redactEmails(value: string) {
  const parts: string[] = [];
  let cursor = 0;
  let at = value.indexOf("@");
  while (at >= 0) {
    let start = at;
    while (start > cursor && isEmailLocal(value.charCodeAt(start - 1))) start -= 1;
    while (start < at && !isAsciiWord(value.charCodeAt(start))) start += 1;

    let end = at + 1;
    let dot = -1;
    let tldLength = 0;
    let validTld = false;
    let validEnd = -1;
    while (end < value.length && isEmailDomain(value.charCodeAt(end))) {
      const code = value.charCodeAt(end);
      if (code === 46) {
        dot = end;
        tldLength = 0;
        validTld = true;
      } else if (dot >= 0) {
        validTld = validTld && isAsciiLetter(code);
        tldLength += 1;
      }
      const next = value.charCodeAt(end + 1);
      if (dot > at + 1 && validTld && tldLength >= 2 && !isAsciiWord(next)) validEnd = end + 1;
      end += 1;
    }

    if (start < at && validEnd > 0) {
      parts.push(value.slice(cursor, start), "[redacted-email]");
      cursor = validEnd;
    }
    at = value.indexOf("@", Math.max(at + 1, cursor));
  }
  parts.push(value.slice(cursor));
  return parts.join("");
}

function isBasicCredential(encoded: string) {
  try {
    return atob(encoded).includes(":");
  } catch {
    // Malformed Base64 and ordinary prose are not credentials.
    return false;
  }
}

function redactBasicValues(value: string) {
  const parts: string[] = [];
  let cursor = 0;
  BASIC_VALUE_PREFIX.lastIndex = 0;
  let match = BASIC_VALUE_PREFIX.exec(value);
  while (match) {
    const opening = consumeOpeningValueWrappers(value, BASIC_VALUE_PREFIX.lastIndex);
    let end = opening.cursor;
    let encoded = "";
    let sawMarker = false;
    while (end < value.length) {
      const markerLength = sanitizationMarkerLengthAt(value, end);
      if (markerLength > 0) {
        sawMarker = true;
        end += markerLength;
        continue;
      }
      if (!BASIC_TOKEN_CHARACTER_VALUE.test(value[end] ?? "")) break;
      encoded += value[end];
      end += 1;
    }
    if (encoded.length > 0 && (sawMarker || isBasicCredential(encoded))) {
      parts.push(value.slice(cursor, opening.cursor), REDACTED_VALUE);
      cursor = end;
      BASIC_VALUE_PREFIX.lastIndex = end;
    }
    match = BASIC_VALUE_PREFIX.exec(value);
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

function isBearerTokenCharacter(character: string | undefined) {
  return character !== undefined && BEARER_TOKEN_CHARACTER_VALUE.test(character);
}

function authorizationValueStartAfterScheme(
  value: string,
  start: number,
  scheme: "basic" | "bearer",
  broadBearerWhitespace = false,
) {
  const isSeparator = (character: string | undefined) =>
    scheme === "bearer" && broadBearerWhitespace
      ? /\s/u.test(character ?? "")
      : character === " " || character === "\t";
  if (!isSeparator(value[start])) return -1;
  let cursor = start + 1;
  while (isSeparator(value[cursor])) cursor += 1;
  return cursor;
}

function authorizationSchemeAt(value: string, start: number, broadBearerWhitespace = false) {
  const scheme =
    value.slice(start, start + 5).toLowerCase() === "basic"
      ? "basic"
      : value.slice(start, start + 6).toLowerCase() === "bearer"
        ? "bearer"
        : undefined;
  if (!scheme) return undefined;
  const valueStart = authorizationValueStartAfterScheme(value, start + scheme.length, scheme, broadBearerWhitespace);
  return valueStart < 0 ? undefined : { scheme, valueStart };
}

function skipNestedAuthorizationSchemes(value: string, start: number, inheritedDelimiter?: QuoteDelimiter) {
  let cursor = start;
  let delimiter = inheritedDelimiter;
  let wrappedNested = false;
  while (true) {
    const nested = authorizationSchemeAt(value, cursor);
    if (!nested) return { cursor, delimiter, wrappedNested };
    const opening = consumeOpeningValueWrappers(value, nested.valueStart);
    wrappedNested ||= opening.delimiter !== undefined;
    delimiter = opening.delimiter ?? delimiter;
    cursor = opening.cursor;
  }
}

function bearerValuePrefixAt(value: string, index: number) {
  if (value.slice(index, index + 6).toLowerCase() !== "bearer") return false;
  if (isAsciiWord(value.charCodeAt(index - 1))) return false;
  return authorizationValueStartAfterScheme(value, index + 6, "bearer", true) >= 0;
}

function sanitizationMarkerLengthAt(value: string, index: number) {
  if (!SANITIZATION_MARKER_FIRST_CHARACTERS.has(value.charAt(index))) return 0;
  return ATOMIC_SANITIZATION_MARKERS.find((marker) => value.startsWith(marker, index))?.length ?? 0;
}

function bearerCandidate(value: string, start: number, delimiter?: QuoteDelimiter) {
  let cursor = start;
  let candidate = "";
  let crossedMarker = false;
  let malformedCredentialPunctuation = false;
  let sawTokenCharacter = false;
  while (cursor < value.length) {
    if (bearerValuePrefixAt(value, cursor)) {
      return { candidate, crossedMarker, end: cursor, malformedCredentialPunctuation, resumeAt: cursor };
    }
    const marker = sanitizationMarkerAt(value, cursor, delimiter);
    if (marker) {
      const markerOnlyValue = start === cursor;
      if (marker.trusted || (markerOnlyValue && atomicMarkerSuffixAt(value, marker.end, delimiter)))
        return { candidate, crossedMarker, end: cursor, malformedCredentialPunctuation, resumeAt: marker.end };
      crossedMarker = true;
      cursor = marker.end;
      continue;
    }

    const character = value[cursor]!;
    const boundary = credentialBoundaryAt(value, cursor);
    if (boundary.boundary || isCredentialQuote(character)) {
      return { candidate, crossedMarker, end: cursor, malformedCredentialPunctuation, resumeAt: cursor };
    }
    if (isBearerTokenCharacter(character)) {
      candidate += character;
      sawTokenCharacter = true;
      cursor += 1;
      continue;
    }

    let continuation = boundary.next;
    while (continuation < value.length) {
      if (sanitizationMarkerLengthAt(value, continuation) > 0 || isBearerTokenCharacter(value[continuation])) break;
      const nextCharacter = value[continuation]!;
      const nextBoundary = credentialBoundaryAt(value, continuation);
      if (nextBoundary.boundary || isCredentialQuote(nextCharacter)) break;
      continuation = nextBoundary.next;
    }
    if (
      continuation >= value.length ||
      (sanitizationMarkerLengthAt(value, continuation) === 0 && !isBearerTokenCharacter(value[continuation]))
    ) {
      return { candidate, crossedMarker, end: cursor, malformedCredentialPunctuation, resumeAt: cursor };
    }
    const separator = value.slice(cursor, continuation);
    malformedCredentialPunctuation ||= sawTokenCharacter && /[^:]/.test(separator);
    candidate += separator;
    cursor = continuation;
  }
  return { candidate, crossedMarker, end: cursor, malformedCredentialPunctuation, resumeAt: cursor };
}

function bearerUrlEnd(value: string, start: number, delimiter?: QuoteDelimiter) {
  if (!/^https?:\/\//i.test(value.slice(start))) return undefined;
  for (let cursor = start; cursor < value.length; cursor += 1) {
    const character = value[cursor];
    if (delimiter) {
      if (quoteEndsCredentialAt(value, cursor, delimiter)) {
        return cursor - precedingBackslashes(value, cursor, start);
      }
      continue;
    }
    if (
      isCredentialQuote(character) ||
      /\s/u.test(character ?? "") ||
      (character !== "&" && STRUCTURAL_CREDENTIAL_BOUNDARIES.includes(character ?? ""))
    ) {
      return cursor;
    }
  }
  return value.length;
}

function redactBearerValues(value: string) {
  const parts: string[] = [];
  let cursor = 0;
  BEARER_VALUE_PREFIX.lastIndex = 0;
  let match = BEARER_VALUE_PREFIX.exec(value);
  while (match) {
    const tokenStart = BEARER_VALUE_PREFIX.lastIndex;
    const opening = consumeOpeningValueWrappers(value, tokenStart);
    const nested = skipNestedAuthorizationSchemes(value, opening.cursor, opening.delimiter);
    const credentialStart = nested.cursor;
    const redactionStart = nested.wrappedNested ? credentialStart : opening.cursor;
    const urlEnd = bearerUrlEnd(value, credentialStart, nested.delimiter);
    if (urlEnd !== undefined) {
      parts.push(value.slice(cursor, redactionStart), REDACTED_VALUE);
      cursor = urlEnd;
      BEARER_VALUE_PREFIX.lastIndex = Math.max(urlEnd, BEARER_VALUE_PREFIX.lastIndex);
      match = BEARER_VALUE_PREFIX.exec(value);
      continue;
    }
    const scanned = bearerCandidate(value, credentialStart, nested.delimiter);
    if (
      (scanned.crossedMarker && scanned.candidate.length > 0) ||
      scanned.malformedCredentialPunctuation ||
      scanned.candidate.length >= 16 ||
      /[0-9._~+/=-]/.test(scanned.candidate)
    ) {
      parts.push(value.slice(cursor, redactionStart), REDACTED_VALUE);
      cursor = scanned.end;
    }
    BEARER_VALUE_PREFIX.lastIndex = Math.max(scanned.resumeAt, BEARER_VALUE_PREFIX.lastIndex);
    match = BEARER_VALUE_PREFIX.exec(value);
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

function partialEmailStart(value: string) {
  const at = value.lastIndexOf("@");
  if (at < 0) return -1;
  let start = at;
  while (start > 0 && isEmailLocal(value.charCodeAt(start - 1))) start -= 1;
  if (start === at) return -1;
  for (let index = at + 1; index < value.length; index += 1) {
    if (!isEmailDomain(value.charCodeAt(index))) return -1;
  }
  return start;
}

type QuoteDelimiter = { backslashes: number; quote: '"' | "'" };

function precedingBackslashes(value: string, index: number, lowerBound = 0) {
  let start = index;
  while (start > lowerBound && value[start - 1] === "\\") start -= 1;
  return index - start;
}

function lastQuoteDelimiter(value: string): QuoteDelimiter | undefined {
  let delimiter: QuoteDelimiter | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (!isCredentialQuote(character)) continue;
    delimiter = { backslashes: precedingBackslashes(value, index), quote: character };
  }
  return delimiter;
}

function consumeOpeningValueWrappers(value: string, start: number) {
  let cursor = start;
  while (cursor < value.length) {
    while (value[cursor] === " " || value[cursor] === "\t") cursor += 1;
    if (cursor >= value.length || sanitizationMarkerLengthAt(value, cursor) > 0) {
      return { cursor, delimiter: undefined };
    }
    if ("[({".includes(value[cursor]!)) {
      cursor += 1;
      continue;
    }
    const slashStart = cursor;
    while (cursor < value.length && value[cursor] === "\\") cursor += 1;
    const character = value[cursor];
    if (isCredentialQuote(character)) {
      return {
        cursor: cursor + 1,
        delimiter: { backslashes: cursor - slashStart, quote: character } satisfies QuoteDelimiter,
      };
    }
    return { cursor: slashStart, delimiter: undefined };
  }
  return { cursor, delimiter: undefined };
}

const STRUCTURAL_CREDENTIAL_BOUNDARIES = ",;}])&";
const TRAILING_CREDENTIAL_PUNCTUATION = ".!?";

function isCredentialQuote(character: string | undefined): character is '"' | "'" {
  return character === '"' || character === "'";
}

function isStructuralCredentialDelimiter(character: string | undefined) {
  return (
    character !== undefined &&
    character !== "" &&
    (/\s/u.test(character) || STRUCTURAL_CREDENTIAL_BOUNDARIES.includes(character))
  );
}

function isHardCredentialDelimiter(character: string | undefined) {
  return isStructuralCredentialDelimiter(character) || isCredentialQuote(character);
}

function credentialBoundaryAt(value: string, index: number) {
  const character = value[index];
  if (character === undefined) return { boundary: true, next: index };
  if (isStructuralCredentialDelimiter(character)) {
    return { boundary: true, next: index + 1 };
  }
  if (!TRAILING_CREDENTIAL_PUNCTUATION.includes(character)) {
    return { boundary: false, next: index + 1 };
  }
  let runEnd = index + 1;
  while (value[runEnd] !== undefined && TRAILING_CREDENTIAL_PUNCTUATION.includes(value[runEnd]!)) runEnd += 1;
  const next = value[runEnd];
  return {
    boundary: next === undefined || isHardCredentialDelimiter(next),
    next: runEnd,
  };
}

function sanitizationMarkerAt(value: string, index: number, delimiter?: QuoteDelimiter) {
  let end = index;
  while (true) {
    const markerLength = sanitizationMarkerLengthAt(value, end);
    if (markerLength === 0) break;
    end += markerLength;
  }
  if (end === index) return undefined;
  const suffix = value[end];
  let quoteIndex = end;
  while (value[quoteIndex] === "\\") quoteIndex += 1;
  const escapedClosingQuote = quoteIndex > end && quoteEndsCredentialAt(value, quoteIndex, delimiter);
  return {
    end,
    trusted: isCredentialQuote(suffix) || escapedClosingQuote || credentialBoundaryAt(value, end).boundary,
  };
}

function atomicMarkerSuffixAt(value: string, start: number, delimiter?: QuoteDelimiter) {
  let cursor = start;
  let sawMarker = false;
  while (cursor < value.length) {
    while (cursor < value.length && TRAILING_CREDENTIAL_PUNCTUATION.includes(value[cursor]!)) cursor += 1;
    if (cursor === value.length) return sawMarker;
    let quoteIndex = cursor;
    while (value[quoteIndex] === "\\") quoteIndex += 1;
    if (sawMarker && quoteEndsCredentialAt(value, quoteIndex, delimiter)) return true;
    const markerLength = sanitizationMarkerLengthAt(value, cursor);
    if (markerLength === 0) return false;
    sawMarker = true;
    cursor += markerLength;
  }
  return sawMarker;
}

function partialBearerValueStart(value: string, allowEmpty = false) {
  BEARER_VALUE_PREFIX.lastIndex = 0;
  try {
    let match = BEARER_VALUE_PREFIX.exec(value);
    while (match) {
      const credentialStart = consumeOpeningValueWrappers(value, BEARER_VALUE_PREFIX.lastIndex).cursor;
      let cursor = credentialStart;
      while (cursor < value.length) {
        const marker = sanitizationMarkerAt(value, cursor);
        if (marker) {
          if (marker.trusted) break;
          cursor = marker.end;
          continue;
        }

        const character = value[cursor]!;
        if (isHardCredentialDelimiter(character)) break;
        cursor += 1;
      }
      if (cursor === value.length && (allowEmpty || cursor > credentialStart)) return credentialStart;
      match = BEARER_VALUE_PREFIX.exec(value);
    }
    return -1;
  } finally {
    BEARER_VALUE_PREFIX.lastIndex = 0;
  }
}

function quoteEndsCredentialAt(value: string, index: number, delimiter: QuoteDelimiter | undefined) {
  const character = value[index];
  if (!isCredentialQuote(character)) return false;
  return delimiter === undefined || character !== delimiter.quote || quoteCloses(delimiter, value, index);
}

function labeledCredentialEnd(value: string, start: number, delimiter: QuoteDelimiter | undefined) {
  for (let index = start; index < value.length;) {
    const marker = sanitizationMarkerAt(value, index, delimiter);
    if (marker) {
      if (marker.trusted || (index === start && atomicMarkerSuffixAt(value, marker.end, delimiter))) {
        return { end: index, resumeAt: marker.end };
      }
      index = marker.end;
      continue;
    }
    const character = value[index]!;
    const boundary = credentialBoundaryAt(value, index);
    if (boundary.boundary) return { end: index, resumeAt: index };
    if (boundary.next > index + 1) {
      index = boundary.next;
      continue;
    }
    if (delimiter) {
      if (!isCredentialQuote(character)) {
        index += 1;
        continue;
      }
      const backslashes = precedingBackslashes(value, index, start);
      if (quoteEndsCredentialAt(value, index, delimiter)) {
        const end = index - backslashes;
        return { end, resumeAt: end };
      }
      index += 1;
      continue;
    }
    if (isCredentialQuote(character)) {
      const end = index - precedingBackslashes(value, index, start);
      return { end, resumeAt: end };
    }
    index += 1;
  }
  return { end: value.length, resumeAt: value.length };
}

type RedactionRange = { start: number; end: number };

function authorizationValueAt(value: string, start: number, inheritedDelimiter?: QuoteDelimiter) {
  const opening = consumeOpeningValueWrappers(value, start);
  const nested = skipNestedAuthorizationSchemes(value, opening.cursor, opening.delimiter ?? inheritedDelimiter);
  const credentialStart = nested.cursor;
  const rangeStart = nested.wrappedNested ? credentialStart : opening.cursor;
  const scanned = labeledCredentialEnd(value, credentialStart, nested.delimiter);
  const end = credentialStart > opening.cursor && scanned.end === credentialStart ? scanned.resumeAt : scanned.end;
  return end > rangeStart
    ? { range: { start: rangeStart, end } satisfies RedactionRange, resumeAt: scanned.resumeAt }
    : { resumeAt: scanned.resumeAt };
}

function redactAuthorizationMatches(value: string, pattern: RegExp) {
  const parts: string[] = [];
  let cursor = 0;
  pattern.lastIndex = 0;
  let match = pattern.exec(value);
  while (match) {
    const scanned = authorizationValueAt(value, pattern.lastIndex, lastQuoteDelimiter(match[1] ?? ""));
    if (scanned.range) {
      parts.push(value.slice(cursor, scanned.range.start), REDACTED_VALUE);
      cursor = scanned.range.end;
    }
    pattern.lastIndex = Math.max(pattern.lastIndex, scanned.resumeAt);
    match = pattern.exec(value);
  }
  if (parts.length === 0) return value;
  parts.push(value.slice(cursor));
  return parts.join("");
}

type SerializedProperty = { key: "name" | "value"; valueStart: number };
type SerializedValue = { range: RedactionRange; segment: number };
type SerializedFrame = {
  authorizationNameSegments: Set<number>;
  values: SerializedValue[];
};

function isSerializedIdentifierCharacter(character: string | undefined) {
  if (character === undefined) return false;
  const code = character.charCodeAt(0);
  return isAsciiLetter(code) || isAsciiDigit(code) || character === "_" || character === "-";
}

function serializedPropertyAt(value: string, index: number): SerializedProperty | undefined {
  if (isSerializedIdentifierCharacter(value[index - 1])) return undefined;
  const key = value.startsWith("name", index) ? "name" : value.startsWith("value", index) ? "value" : undefined;
  if (!key || isSerializedIdentifierCharacter(value[index + key.length])) return undefined;
  let cursor = index + key.length;
  const quoteStart = cursor;
  while (value[cursor] === "\\") cursor += 1;
  if (value[cursor] === '"' || value[cursor] === "'") cursor += 1;
  else if (cursor !== quoteStart) return undefined;
  while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
  if (value[cursor] !== ":") return undefined;
  cursor += 1;
  while (/\s/u.test(value[cursor] ?? "")) cursor += 1;
  return { key, valueStart: cursor };
}

function quoteCloses(delimiter: QuoteDelimiter, value: string, index: number) {
  if (value[index] !== delimiter.quote) return false;
  const backslashes = precedingBackslashes(value, index);
  return (
    backslashes % 2 === delimiter.backslashes % 2 &&
    (delimiter.backslashes === 0 || backslashes <= delimiter.backslashes)
  );
}

function serializedAuthorizationNameAt(value: string, start: number) {
  let cursor = start;
  const slashStart = cursor;
  while (value[cursor] === "\\") cursor += 1;
  const quote = value[cursor];
  if (quote === '"' || quote === "'") {
    const delimiter = { backslashes: cursor - slashStart, quote } satisfies QuoteDelimiter;
    const contentStart = cursor + 1;
    for (cursor = contentStart; cursor < value.length; cursor += 1) {
      if (!quoteCloses(delimiter, value, cursor)) continue;
      const contentEnd = cursor - precedingBackslashes(value, cursor, contentStart);
      return AUTHORIZATION_LABEL_VALUE.test(value.slice(contentStart, contentEnd));
    }
    return false;
  }
  const contentStart = cursor;
  while (/[A-Za-z0-9_-]/.test(value[cursor] ?? "")) cursor += 1;
  return cursor > contentStart && AUTHORIZATION_LABEL_VALUE.test(value.slice(contentStart, cursor));
}

function serializedAuthorizationValueAt(value: string, start: number): RedactionRange | undefined {
  const wrapper = consumeOpeningValueWrappers(value, start);
  const scheme = authorizationSchemeAt(value, wrapper.cursor, true);
  return scheme ? authorizationValueAt(value, scheme.valueStart, wrapper.delimiter).range : undefined;
}

function canOpenSerializedQuote(value: string, index: number) {
  let cursor = index - precedingBackslashes(value, index) - 1;
  while (cursor >= 0 && /\s/u.test(value[cursor]!)) cursor -= 1;
  return cursor < 0 || "[{(,:=>".includes(value[cursor]!);
}

function appendSerializedFrameRanges(frame: SerializedFrame, ranges: RedactionRange[]) {
  for (const candidate of frame.values) {
    if (frame.authorizationNameSegments.has(candidate.segment)) ranges.push(candidate.range);
  }
}

function applyRedactionRanges(value: string, ranges: RedactionRange[]) {
  if (ranges.length === 0) return value;
  const endAt = new Uint32Array(value.length + 1);
  for (const range of ranges) endAt[range.start] = Math.max(endAt[range.start]!, range.end);
  const parts: string[] = [];
  let sourceCursor = 0;
  for (let index = 0; index < value.length; index += 1) {
    const end = endAt[index]!;
    if (end <= index || index < sourceCursor) continue;
    parts.push(value.slice(sourceCursor, index), REDACTED_VALUE);
    sourceCursor = end;
    index = end - 1;
  }
  parts.push(value.slice(sourceCursor));
  return parts.join("");
}

function redactSerializedAuthorizationObjects(value: string) {
  const ranges: RedactionRange[] = [];
  const frames: SerializedFrame[] = [{ authorizationNameSegments: new Set(), values: [] }];
  let segment = 0;
  let delimiter: (QuoteDelimiter & { contentStart: number }) | undefined;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (delimiter) {
      if (quoteCloses(delimiter, value, index)) delimiter = undefined;
    } else if (isCredentialQuote(character) && canOpenSerializedQuote(value, index)) {
      delimiter = {
        backslashes: precedingBackslashes(value, index),
        quote: character,
        contentStart: index + 1,
      };
    }

    const property =
      delimiter === undefined || delimiter.contentStart === index ? serializedPropertyAt(value, index) : undefined;
    if (property) {
      const frame = frames.at(-1)!;
      const frameSegment = frames.length === 1 ? segment : 0;
      if (property.key === "name" && serializedAuthorizationNameAt(value, property.valueStart)) {
        frame.authorizationNameSegments.add(frameSegment);
      } else if (property.key === "value") {
        const range = serializedAuthorizationValueAt(value, property.valueStart);
        if (range) frame.values.push({ range, segment: frameSegment });
      }
    }

    if (delimiter) continue;
    if (character === "{") {
      frames.push({ authorizationNameSegments: new Set(), values: [] });
    } else if (character === "}" && frames.length > 1) {
      appendSerializedFrameRanges(frames.pop()!, ranges);
    } else if (frames.length === 1 && (character === "\n" || character === ";")) {
      segment += 1;
    }
  }
  while (frames.length > 1) appendSerializedFrameRanges(frames.pop()!, ranges);
  appendSerializedFrameRanges(frames[0]!, ranges);
  return applyRedactionRanges(value, ranges);
}

function redactLabeledAuthorizationValues(value: string) {
  const labeled = redactAuthorizationMatches(value, LABELED_AUTHORIZATION_PREFIX);
  return redactSerializedAuthorizationObjects(labeled);
}

function redactKnownValues(value: string) {
  let safe = redactLabeledAuthorizationValues(value);
  safe = redactBasicValues(safe);
  safe = redactBearerValues(safe).replace(SECRET_VALUE, "[redacted-secret]").replace(URL_QUERY, "$1");
  return redactEmails(safe);
}

const EXACT_SANITIZATION_MARKERS = new Set<string>(ATOMIC_SANITIZATION_MARKERS);

function atomicRedactionPrefix(value: string, limit: number) {
  const prefix = wellFormedPrefix(value, limit);
  if (prefix.length === value.length) return value;
  let end = prefix.length;
  let previousEnd: number;
  do {
    previousEnd = end;
    for (const marker of ATOMIC_SANITIZATION_MARKERS) {
      const start = value.lastIndexOf(marker, Math.max(0, end - 1));
      if (start >= 0 && start < end && start + marker.length > end) end = start;
    }
  } while (end < previousEnd);
  return wellFormedPrefix(value, end);
}

function artificialCutProbe(value: string) {
  let end = value.length;
  while (end > 0 && TRAILING_CREDENTIAL_PUNCTUATION.includes(value[end - 1]!)) end -= 1;
  const punctuation = value.slice(end);
  let sawMarker = false;
  let previousEnd: number;
  do {
    previousEnd = end;
    const marker = ATOMIC_SANITIZATION_MARKERS.find((candidate) => value.endsWith(candidate, end));
    if (marker) {
      sawMarker = true;
      end -= marker.length;
    }
    while (end > 0 && TRAILING_CREDENTIAL_PUNCTUATION.includes(value[end - 1]!)) end -= 1;
  } while (end < previousEnd);
  return { prefix: value.slice(0, end), punctuation, sawMarker, suffix: value.slice(end) };
}

function partialSecretStart(value: string) {
  let runStart = value.length;
  while (runStart > 0) {
    const code = value.charCodeAt(runStart - 1);
    if (!isAsciiWord(code) && code !== 45) break;
    runStart -= 1;
  }

  const lastUnderscore = value.lastIndexOf("_");
  for (let index = runStart; index < value.length; index += 1) {
    if (index > 0 && isAsciiWord(value.charCodeAt(index - 1))) continue;
    const candidate = value.slice(index, index + SECRET_PREFIX_MAX_LENGTH).toLowerCase();
    if (GENERIC_SECRET_PREFIXES.some((prefix) => candidate.startsWith(prefix))) return index;
    if (XOX_SECRET_PREFIXES.some((prefix) => candidate.startsWith(prefix)) && lastUnderscore < index + 5) return index;
  }
  return -1;
}

function openSensitiveSuffixAtCut(value: string) {
  const { prefix, punctuation, sawMarker, suffix } = artificialCutProbe(value);
  const basic = PARTIAL_BASIC_VALUE.exec(prefix);
  const basicLength = basic?.[2]?.length ?? 0;
  if (basicLength > 0) return { marker: REDACTED_VALUE, start: prefix.length - basicLength, suffix };
  const bearerStart = partialBearerValueStart(prefix, punctuation.length > 0 && !sawMarker);
  if (bearerStart >= 0) return { marker: REDACTED_VALUE, start: bearerStart, suffix };
  const secretStart = partialSecretStart(prefix);
  if (secretStart >= 0) return { marker: "[redacted-secret]", start: secretStart, suffix };
  const emailStart = partialEmailStart(prefix);
  return emailStart >= 0 ? { marker: "[redacted-email]", start: emailStart, suffix } : undefined;
}

function redactTruncationBoundary(value: string, limit: number) {
  const replacement = openSensitiveSuffixAtCut(value);
  if (!replacement) return value;
  const prefix = value.slice(0, replacement.start);
  const redacted = prefix + replacement.marker;
  if (redacted.length > limit) return prefix;
  let suffix = replacement.suffix;
  const leadingMarker = ATOMIC_SANITIZATION_MARKERS.find((marker) => suffix.startsWith(marker));
  if (leadingMarker) {
    suffix = suffix.slice(leadingMarker.length);
    let punctuationEnd = 0;
    while (punctuationEnd < suffix.length && TRAILING_CREDENTIAL_PUNCTUATION.includes(suffix[punctuationEnd]!)) {
      punctuationEnd += 1;
    }
    if (ATOMIC_SANITIZATION_MARKERS.some((marker) => suffix.startsWith(marker, punctuationEnd))) {
      suffix = suffix.slice(punctuationEnd);
    }
  }
  const withSuffix = redacted + suffix;
  return withSuffix.length <= limit ? withSuffix : redacted;
}

function boundedSanitizedPayload(value: string, limit: number) {
  const prefix = value.length <= limit ? value : atomicRedactionPrefix(value, limit);
  return redactTruncationBoundary(prefix, limit);
}

function boundedSanitizedString(value: string, limit: number) {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, Math.max(0, limit));
  const payloadLimit = limit - TRUNCATION_MARKER.length;
  return boundedSanitizedPayload(value, payloadLimit) + TRUNCATION_MARKER;
}

function redactedString(value: string, limit = LOG_TEXT_LIMIT) {
  const existingCut = value.endsWith(TRUNCATION_MARKER);
  if (!existingCut && value.length <= limit) return boundedSanitizedString(redactKnownValues(value), limit);
  if (limit <= TRUNCATION_MARKER.length) return TRUNCATION_MARKER.slice(0, Math.max(0, limit));
  const payloadLimit = limit - TRUNCATION_MARKER.length;
  let rawPayload = value;
  if (existingCut) rawPayload = rawPayload.slice(0, -TRUNCATION_MARKER.length);
  const rawPrefix = wellFormedPrefix(rawPayload, payloadLimit);
  const safeBoundary = redactTruncationBoundary(rawPrefix, payloadLimit);
  const safe = redactKnownValues(safeBoundary);
  return boundedSanitizedPayload(safe, payloadLimit) + TRUNCATION_MARKER;
}

function uniqueKey(base: string, occupied: (candidate: string) => boolean) {
  if (!occupied(base)) return base;
  for (let index = 2; ; index += 1) {
    const suffix = `#${index}`;
    const trailingMarker = ATOMIC_SANITIZATION_MARKERS.find((marker) => base.endsWith(marker));
    const candidate = trailingMarker
      ? atomicRedactionPrefix(
          base.slice(0, -trailingMarker.length),
          LOG_IDENTIFIER_LIMIT - trailingMarker.length - suffix.length,
        ) +
        trailingMarker +
        suffix
      : atomicRedactionPrefix(base, LOG_IDENTIFIER_LIMIT - suffix.length) + suffix;
    if (!occupied(candidate)) return candidate;
  }
}

function uniqueSafeKey(target: Record<string, unknown>, rawKey: string) {
  return uniqueKey(redactedString(rawKey, LOG_IDENTIFIER_LIMIT) || EMPTY_KEY, (key) => Object.hasOwn(target, key));
}

type BoundedFragment = {
  full: string;
  minimum: string;
  compact?: (limit: number) => string | undefined;
};

function containerLength(fragments: readonly string[]) {
  return 2 + fragments.reduce((length, fragment) => length + fragment.length, 0) + Math.max(0, fragments.length - 1);
}

function compactStringFragment(value: string, wrap: (valueJson: string) => string, limit: number) {
  let low = TRUNCATION_MARKER.length;
  let high = Math.min(value.length - 1, limit);
  let best: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = wrap(JSON.stringify(boundedSanitizedString(value, middle)));
    if (candidate.length <= limit) {
      best = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return best;
}

function compactNestedFragment(
  value: object,
  serialized: string | undefined,
  wrap: (valueJson: string) => string,
  limit: number,
) {
  const valueLimit = limit - wrap("").length;
  if (valueLimit < 2) return undefined;
  const compacted = boundedNestedJsonFromSerialization(value, valueLimit, serialized);
  if (!compacted.startsWith("[") && !compacted.startsWith("{")) {
    return undefined;
  }
  const candidate = wrap(compacted);
  return candidate.length <= limit ? candidate : undefined;
}

function boundedFragment(
  value: unknown,
  keyJson?: string,
  serialized = JSON.stringify(value) ?? "null",
): BoundedFragment {
  const wrap = (valueJson: string) => (keyJson === undefined ? valueJson : `${keyJson}:${valueJson}`);
  const full = wrap(serialized);
  const omitted = wrap(JSON.stringify(OMITTED_VALUE));
  const atomic = typeof value === "string" && EXACT_SANITIZATION_MARKERS.has(value);
  const minimum = atomic || full.length <= omitted.length ? full : omitted;
  return {
    full,
    minimum,
    ...(!atomic && typeof value === "string" && full !== minimum
      ? { compact: (limit: number) => compactStringFragment(value, wrap, limit) }
      : value !== null && typeof value === "object" && full !== minimum
        ? { compact: (limit: number) => compactNestedFragment(value, serialized, wrap, limit) }
        : {}),
  };
}

function unavailableJson(limit: number, marker: string) {
  const serialized = JSON.stringify(marker);
  if (serialized.length <= limit) return serialized;
  if (limit >= 4) return "null";
  return limit >= 2 ? JSON.stringify("") : "";
}

function packBoundedFragments(
  fragments: readonly BoundedFragment[],
  opening: "[" | "{",
  closing: "]" | "}",
  omission: string,
  limit: number,
) {
  const minimums = fragments.map(({ minimum }) => minimum);
  const allFit = containerLength(minimums) <= limit;
  const retained: Array<{ descriptor: BoundedFragment; value: string }> = [];
  let dropped = false;

  if (allFit) {
    for (let index = 0; index < fragments.length; index += 1) {
      retained.push({ descriptor: fragments[index]!, value: minimums[index]! });
    }
  } else {
    if (containerLength([omission]) > limit) return unavailableJson(limit, OMITTED_ENTRIES);
    for (let index = 0; index < fragments.length; index += 1) {
      const minimum = minimums[index]!;
      if (containerLength([...retained.map(({ value }) => value), minimum, omission]) <= limit) {
        retained.push({ descriptor: fragments[index]!, value: minimum });
      } else {
        dropped = true;
      }
    }
  }

  const rendered = () => [...retained.map(({ value }) => value), ...(dropped ? [omission] : [])];
  for (const item of retained) {
    const available = item.value.length + limit - containerLength(rendered());
    const candidate =
      item.descriptor.full.length <= available ? item.descriptor.full : item.descriptor.compact?.(available);
    if (candidate && candidate !== item.value) item.value = candidate;
  }
  return `${opening}${rendered().join(",")}${closing}`;
}

function boundedNestedJsonFromSerialization(value: unknown, limit: number, serialized: string | undefined) {
  if (limit < 2) return "";
  if (serialized !== undefined && serialized.length <= limit) return serialized;

  if (Array.isArray(value)) {
    return packBoundedFragments(
      Array.from(value, (item) => {
        const itemJson = JSON.stringify(item) ?? "null";
        return boundedFragment(item, undefined, itemJson);
      }),
      "[",
      "]",
      JSON.stringify(OMITTED_ENTRIES),
      limit,
    );
  }

  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).flatMap(([key, item]) => {
      const itemJson = JSON.stringify(item);
      return itemJson === undefined ? [] : [{ item, itemJson, key }];
    });
    const keys = new Set(entries.map(({ key }) => key));
    const omissionKey = uniqueKey("omitted", (key) => keys.has(key));
    return packBoundedFragments(
      entries.map(({ item, itemJson, key }) => boundedFragment(item, JSON.stringify(key), itemJson)),
      "{",
      "}",
      `${JSON.stringify(omissionKey)}:${JSON.stringify(OMITTED_ENTRIES)}`,
      limit,
    );
  }

  return unavailableJson(limit, OMITTED_VALUE);
}

/** @internal Exported for focused size-boundary tests. */
export function boundedNestedJson(value: unknown, limit: number) {
  return boundedNestedJsonFromSerialization(value, limit, JSON.stringify(value));
}

export function safeTelemetryErrorMessage(error: unknown, fallback: string, limit = PERSISTED_ERROR_MESSAGE_LIMIT) {
  return redactedString(rawSafeErrorMessage(error, fallback), limit);
}

function safeNested(value: unknown, depth: number, seen: WeakSet<object>, budget: { remaining: number }): unknown {
  if (budget.remaining <= 0) return OMITTED_ENTRIES;
  budget.remaining -= 1;
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return typeof value === "number" && !Number.isFinite(value) ? String(value) : value;
  }
  if (typeof value === "string") return redactedString(value);
  if (typeof value === "bigint") return boundedLogString(String(value), LOG_IDENTIFIER_LIMIT);
  if (value === undefined) return undefined;
  if (typeof value !== "object") return typeof value === "function" ? FUNCTION_OMITTED : SYMBOL_OMITTED;
  if (depth >= 3) return DEPTH_OMITTED;
  if (seen.has(value)) return CIRCULAR_VALUE;
  seen.add(value);
  if (value instanceof Error) return errorLogFields(value, redactedString);
  let allKeys: string[];
  try {
    allKeys = Object.keys(value);
  } catch {
    return OBJECT_OMITTED;
  }
  const keys = allKeys.slice(0, 30);
  const keysTruncated = keys.length < allKeys.length;
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    let omitted = keysTruncated;
    for (const key of keys) {
      if (budget.remaining <= 0) {
        omitted = true;
        break;
      }
      try {
        result.push(safeNested(Reflect.get(value, key), depth + 1, seen, budget));
      } catch {
        result.push(PROPERTY_OMITTED);
      }
    }
    if (omitted) result.push(OMITTED_ENTRIES);
    return result;
  }
  const result = Object.create(null) as Record<string, unknown>;
  let omitted = keysTruncated;
  for (const key of keys) {
    if (budget.remaining <= 0) {
      omitted = true;
      break;
    }
    const safeKey = uniqueSafeKey(result, key);
    if (SENSITIVE_KEY.test(key)) {
      result[safeKey] = REDACTED_VALUE;
      continue;
    }
    try {
      result[safeKey] = safeNested(Reflect.get(value, key), depth + 1, seen, budget);
    } catch {
      result[safeKey] = PROPERTY_OMITTED;
    }
  }
  if (omitted) result[uniqueKey("omitted", (candidate) => Object.hasOwn(result, candidate))] = OMITTED_ENTRIES;
  return result;
}

function safeField(key: string, value: unknown): string | number | boolean | null | undefined {
  if (SENSITIVE_KEY.test(key)) return "[redacted]";
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalizedKey = key.toLowerCase();
    const limit = normalizedKey.endsWith("stack")
      ? LOG_STACK_LIMIT
      : normalizedKey.endsWith("id")
        ? LOG_IDENTIFIER_LIMIT
        : LOG_TEXT_LIMIT;
    return redactedString(value, limit);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return boundedLogString(String(value), LOG_IDENTIFIER_LIMIT);
  if (value === undefined) return undefined;
  try {
    return boundedNestedJson(safeNested(value, 0, new WeakSet(), { remaining: NESTED_VALUE_BUDGET }), LOG_TEXT_LIMIT);
  } catch {
    return typeof value === "function" ? FUNCTION_OMITTED : OBJECT_OMITTED;
  }
}

function structuredLog(
  level: LogLevel,
  event: string,
  component: string,
  message: string,
  fields: LogFields = {},
  error?: unknown,
) {
  const context = currentObservabilityContext();
  const safeContext: Record<string, unknown> = {};
  if (context) {
    for (const [key, value] of Object.entries(context)) {
      if (key === "metricRouteTemplate") continue;
      const safe = safeField(key, value);
      if (safe !== undefined) safeContext[key] = safe;
    }
  }
  const safeFields = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (RESERVED_LOG_FIELDS.has(key)) continue;
    const safe = safeField(key, value);
    if (safe !== undefined) safeFields[uniqueSafeKey(safeFields, key)] = safe;
  }
  const normalizedError: Record<string, unknown> = {};
  if (error !== undefined) {
    for (const [key, value] of Object.entries(errorLogFields(error, redactedString))) {
      if (value === undefined) continue;
      if (value !== null && typeof value === "object") {
        try {
          normalizedError[key] = boundedNestedJson(value, LOG_TEXT_LIMIT);
        } catch {
          normalizedError[key] = OBJECT_OMITTED;
        }
      } else {
        normalizedError[key] = value;
      }
    }
  }
  const record = {
    ...safeFields,
    ...normalizedError,
    ...safeContext,
    schema: OBSERVABILITY_SCHEMA,
    event: boundedLogString(event, LOG_IDENTIFIER_LIMIT),
    severity: level,
    component: boundedLogString(component, LOG_IDENTIFIER_LIMIT),
    message: redactedString(message),
  };
  console[level](record);
  return record;
}

export const logger = {
  debug: (event: string, component: string, message: string, fields?: LogFields) =>
    structuredLog("debug", event, component, message, fields),
  info: (event: string, component: string, message: string, fields?: LogFields) =>
    structuredLog("info", event, component, message, fields),
  warn: (event: string, component: string, message: string, fields?: LogFields, error?: unknown) =>
    structuredLog("warn", event, component, message, fields, error),
  error: (event: string, component: string, message: string, fields?: LogFields, error?: unknown) =>
    structuredLog("error", event, component, message, fields, error),
};

export interface MetricPoint {
  event: string;
  component: string;
  operation?: string;
  outcome?: string;
  code?: string;
  subtype?: string;
  durationMs?: number;
  bytes?: number;
  attempts?: number;
  lagMs?: number;
  backlog?: number;
  connections?: number;
}

export function recordMetric(env: Env, point: MetricPoint) {
  env.OBSERVABILITY?.writeDataPoint({
    indexes: [boundedLogString(point.event, LOG_IDENTIFIER_LIMIT)],
    blobs: [
      OBSERVABILITY_SCHEMA,
      boundedLogString(point.component, LOG_IDENTIFIER_LIMIT),
      boundedLogString(point.operation ?? "", LOG_IDENTIFIER_LIMIT),
      boundedLogString(point.outcome ?? "", LOG_IDENTIFIER_LIMIT),
      boundedLogString(point.code ?? "", LOG_IDENTIFIER_LIMIT),
      boundedLogString(point.subtype ?? "", LOG_IDENTIFIER_LIMIT),
      env.CF_VERSION_METADATA?.id ?? "local",
    ],
    doubles: [
      point.durationMs ?? 0,
      point.bytes ?? 0,
      point.attempts ?? 0,
      point.lagMs ?? 0,
      point.backlog ?? 0,
      point.connections ?? 0,
      point.bytes === undefined ? 0 : 1,
    ],
  });
}

export function traced<T>(
  tracing: ExecutionContext["tracing"] | undefined,
  name: string,
  attributes: Readonly<Record<string, string | number | boolean | undefined>>,
  callback: () => T,
) {
  if (!tracing) return callback();
  return tracing.enterSpan(name, (span) => {
    for (const [key, value] of Object.entries(attributes)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    return callback();
  });
}
