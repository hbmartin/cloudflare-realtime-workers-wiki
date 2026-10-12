# Contributing

Use the [README quick start](README.md#quick-start) to run NoteFlare. Contributor checks additionally require the pinned Semgrep environment below. Keep application changes and their feature controls, compatibility notes, and evidence together.

## Development and checks

Requires Node.js 22.22.2+ in the Node 22 release line, 24.15+ in the Node 24 release line, or 26+; pnpm 11.18.0; and
[uv](https://docs.astral.sh/uv/) to provision Python 3.13.15 for the pinned Semgrep middleware-policy check.

```sh
uv venv --python 3.13.15 --seed .venv
source .venv/bin/activate
python -m pip install --disable-pip-version-check --require-hashes -r requirements-semgrep.txt
pnpm install
cp .dev.vars.local.example .dev.vars
```

Set a strong local `BETTER_AUTH_SECRET` and choose a `BOOTSTRAP_TOKEN` in `.dev.vars`, then initialize and start:

```sh
pnpm db:local
pnpm dev
```

Open `http://localhost:5173`, enter that token on the first-run screen, and create the owner.

Every account must enroll an authenticator or passkey and save recovery codes before entering the workspace. See [account protection, recovery, and rollout](docs/ACCOUNT_SECURITY.md). Upgrade warnings belong in [Upgrading](docs/UPGRADING.md).

Useful checks:

```sh
pnpm check                 # formatting, lint, types, tests, dead code, generated types, Worker dry run
pnpm test:unit             # fast unit and React component tests
pnpm test:worker           # isolated Workers, D1, R2, and Durable Object integration tests
pnpm test:e2e              # Chromium UI integration suite against a fresh local D1 state
pnpm test:e2e:nightly      # Chromium, Firefox, WebKit, and mobile Chromium
pnpm load:realtime         # 30 authenticated local realtime connections
```

`pnpm lint` uses Oxlint with type-aware rules, `pnpm format:check` uses Oxfmt, and `pnpm analyze` uses
Fallow for unused dependencies and dead code. `pnpm analyze:audit` adds a changed-code review of duplication and
maintainability findings without treating the repository's inherited complexity as a new gate. TypeScript is checked
separately for the browser, Worker, unit tests, Worker integration tests, and build configuration. Coverage thresholds are
enforced by `pnpm test:coverage` and `pnpm test:worker:coverage`. Semgrep and its Python dependencies are version- and
hash-locked in `requirements-semgrep.txt`; keep the virtual environment active when running `pnpm check`.

The E2E server deletes only `.wrangler/e2e`, reapplies every D1 migration, and injects dedicated local test bindings.
Fresh local realtime load checks enroll their own authenticator automatically. To run the realtime load check against a
deployed environment, set `NOTES_LOAD_BASE_URL`, `NOTES_LOAD_EMAIL`, and `NOTES_LOAD_PASSWORD` for an account with an
enrolled authenticator, plus either `NOTES_LOAD_TOTP_CODE` (a current six-digit code) or `NOTES_LOAD_TOTP_SECRET` (the
Base32 authenticator secret used to generate a code). `NOTES_LOAD_CONNECTIONS` and `NOTES_LOAD_HOLD_MS` tune the
connection count and hold time.

Pull requests run static checks, coverage suites, production builds, a Wrangler deployment dry run, and Chromium UI
checks in separate CI jobs. The scheduled workflow adds the full browser/mobile matrix and realtime load checks. Configure
the `STAGING_BASE_URL` repository variable plus `STAGING_LOAD_EMAIL`, `STAGING_LOAD_PASSWORD`, and
`STAGING_LOAD_TOTP_SECRET` secrets to include a deployed staging target in that load check. The TOTP secret is exposed
only to the staging load-check step.

## Plugin verification

`pnpm dev` builds the UI before starting Vite and watches its imports for rebuilds. `pnpm build`, Worker tests, and local browser tests also build it.

<!-- check-docs:ignore-next -->

Generated `public/plugin-ui/noteflare.html` is ignored by Git and copied into production assets.

```sh
pnpm check
pnpm exec playwright test --project=chromium tests/e2e/plugin-ui.spec.ts
pnpm plugin:eval
```

The browser test exercises the actual bundle in a simulated host under a strict CSP without `unsafe-eval`. It verifies the bridge handshake, guarded writes, conflict preservation, navigation guard, and absence of automatic external resources. It is distinct from installed ChatGPT acceptance.

The evaluation command uses `OPENAI_API_KEY` and optional `NOTEFLARE_EVAL_MODEL` (default `gpt-5.4-mini`). It uses the same schemas/descriptions as the server and the workflow skill, sends only synthetic cases, sets `store:false` for API responses, and never executes returned MCP calls. The 16 cases cover positive selections, revision guards and operation-ID reuse, unrelated prompts, local-only drafts, source instructions, and unsupported table edits, typed table/diagram reads, and cursor continuation. Each asserted top-level argument uses deep equality: nested objects and arrays must match exactly, including array order; unasserted top-level arguments remain allowed. The retry case asserts the original page ID, complete command, operation ID, revision, and epoch. Results are checkpointed in `plugins/noteflare/evals/results.json` for each processed case. Malformed or incomplete responses are recorded as failures with a reason and available raw arguments, and later cases continue. API and transport failures are recorded as blocked with remaining cases not run. Offline evaluator tests use an isolated report and do not replace this paid-run evidence.

Current and historical evaluation outcomes belong in [plugin evidence](docs/evidence/CHATGPT_PLUGIN_VERIFICATION.md); mock tests do not establish a paid provider or installed-client result.

## Migrations

Applied D1 migrations are forward-only. Never edit/reorder an applied SQL migration or mark it applied by hand. Add a forward migration, keep its prerequisite code rollout explicit, and use the guarded runner. Prefixes are not unique identifiers: both `0030_observability.sql` and `0030_security_review_followups.sql` exist. Durable Object class migrations are append-only too. See [Upgrading](docs/UPGRADING.md).

## Documentation conventions

Write for members, operators, integrators, or contributors and link each new guide through [the documentation index](docs/README.md) or its research/evidence/specification indexes. Keep task instructions in guides, configuration in exact-name reference tables, contracts in specifications, and dated test outcomes in evidence.

Run `pnpm check:docs` after moving a file, renaming a heading, adding a binding/secret, or adding a document. Local links must stay inside the Git root and match paths and heading fragments exactly. Use repository links, not paths into a sibling checkout. External availability is reviewed separately from the deterministic checker.

The checker also validates project scripts, dependency executables, and explicit repository paths in inline code and shell examples in the README and current operator guides. Use `pnpm run deploy` because pnpm also has its own built-in deploy command. Mark placeholder names with angle brackets or braces. For schematic or generated examples, put `<!-- check-docs:ignore-next -->` immediately before the block, or label a shell fence `sh non-executable`. Historical evidence retains link checks without requiring old commands or files to exist today.

Record implementation SHA, deployed SHA, production/default flags, and outstanding live acceptance separately. Preserve dated research as historical rather than silently updating old forecasts. Never put credentials, prompts, private drafts, or provider tokens into documentation or screenshots.

## Screenshot

The README screenshot is a real desktop capture from a local installation with synthetic content and light mode. To refresh it, use the local browser-test bootstrap helper, populate a handbook and comment, expose navigation and Comments, and capture at 1440×900 with animations disabled into `docs/assets/workspace.png`. Review it for readable text and accidental private data before committing.
