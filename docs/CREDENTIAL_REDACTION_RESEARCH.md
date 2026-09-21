# Credential redaction research

Research date: 2026-09-21

## Conclusions

Keep credential redaction at the observability boundary, retain the bounded scanner, and add no dependency. The important
correctness rule is that a size-limit cut is not a trustworthy token boundary. The implementation therefore applies one
cut-aware adapter to partial Bearer, Basic, email, and secret-prefix detection while preserving complete sanitizer markers
as lexical atoms and keeping repeated sanitization idempotent.

## Security and standards guidance

- The [OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html) says access
  tokens, authentication passwords, and other primary secrets should generally not be recorded directly in logs. It also
  recommends sanitizing event data and centralizing consistent logging behavior. This supports enforcing redaction in the
  shared observability serializer rather than relying on each caller.
- [CWE-532](https://cwe.mitre.org/data/definitions/532.html) covers sensitive information written to log files.
  [CWE-180](https://cwe.mitre.org/data/definitions/180.html) describes validation performed before canonicalization; its
  ordering lesson applies here by analogy. Treating a truncated prefix as a complete value validates a representation
  created by truncation rather than the original input.
- [RFC 9110, section 11](https://www.rfc-editor.org/rfc/rfc9110.html#section-11) defines HTTP authentication terminology,
  while [RFC 6750, section 2.1](https://www.rfc-editor.org/rfc/rfc6750.html#section-2.1) defines Bearer use in the
  `Authorization` header. The project intentionally recognizes malformed diagnostic representations more broadly than the
  wire grammar because logs can contain partially serialized or truncated values.
- ECMAScript defines `\s` as WhiteSpace plus LineTerminator characters in the
  [CharacterSetMatcher semantics](https://tc39.es/ecma262/multipage/text-processing.html#sec-runtime-semantics-charactersetmatcher)
  and the [lexical grammar](https://tc39.es/ecma262/multipage/ecmascript-language-lexical-grammar.html#sec-white-space).
  That supports the existing JavaScript-whitespace policy for Bearer values, including Unicode spaces and line breaks.
  Basic remains intentionally limited to space and tab.
- OpenTelemetry's [redaction processor](https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/processor/redactionprocessor/README.md)
  and its [telemetry transformation guidance](https://opentelemetry.io/docs/collector/transforming-telemetry/) favor
  structured allowlisting and redaction. They are useful defense-in-depth for structured attributes, but do not replace
  this application's string scanner for bounded exception messages and serialized header fragments.

## npm package survey

| Package                                                                                                                             | What it handles                                                                                                                                                             | Why it is not a drop-in replacement                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Pino redaction](https://github.com/pinojs/pino/blob/main/docs/redaction.md) / [`@pinojs/redact`](https://github.com/pinojs/redact) | Configured object paths                                                                                                                                                     | It does not recognize credentials embedded in arbitrary, truncated strings.                                                                                                                                                               |
| [`fast-redact`](https://github.com/davidmarkclements/fast-redact)                                                                   | Fast object-path redaction                                                                                                                                                  | It has the same path-oriented model and uses generated functions, which does not match this Workers scanner or its content-security posture.                                                                                              |
| [`@visulima/redact`](https://github.com/visulima/visulima/blob/main/packages/data-manipulation/redact/README.md)                    | General string and object redaction, with [workerd tests](https://github.com/visulima/visulima/blob/main/packages/data-manipulation/redact/__tests__/workerd/index.test.ts) | It is the closest runtime-compatible option, but its Bearer matching does not provide this project's partial-token, artificial-cut, atomic-marker, formatting, and idempotence contract, and it does not cover Basic in the required way. |
| [`flare-redact`](https://github.com/flare-collection/flare-redact)                                                                  | Pattern-based secret and PII detection                                                                                                                                      | Its [detectors](https://github.com/flare-collection/flare-redact/blob/main/src/detectors.ts) use different length and case assumptions and have no cut-aware marker semantics.                                                            |
| [`@arcjet/redact`](https://github.com/arcjet/arcjet-js/tree/main/redact)                                                            | WASM-based PII redaction                                                                                                                                                    | It targets PII rather than authorization secrets and adds an asynchronous WASM integration without solving the truncation contract.                                                                                                       |
| [`@redactpii/node`](https://github.com/wrannaman/redactpii-node)                                                                    | PII redaction                                                                                                                                                               | Its domain and Node-oriented integration do not address partial credentials in Workers telemetry.                                                                                                                                         |

## Design implications

An unbounded scan would weaken the current memory and output-size guarantees. Finite lookahead only moves the artificial
endpoint, so it cannot solve the class of bug. The smallest robust change is to keep the existing natural-end scanners and
adapt only their interpretation of the known truncation cut. Tests must cover all atomic markers, terminal punctuation,
marker-only values, wrappers, UTF-16 well-formedness, output limits, and the fixed-point property.
