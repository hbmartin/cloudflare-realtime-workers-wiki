# Continuous deployment

`.github/workflows/deploy.yml` considers every completed `main`-branch CI run and deploys only when
that run passed for the current tip of `main`. It also supports manual `workflow_dispatch`. This
document covers what those triggers imply, the gate that protects them, and the account credentials
they need.

[Deployment](DEPLOYMENT.md) remains the reference for standing an installation up by hand;
everything the workflow does is the manual sequence in
[Migrate and deploy](DEPLOYMENT.md#5-migrate-and-deploy), in the same order.

## What deploying on every push means here

There is no staging environment. A commit that reaches `main` reaches users, and the only thing
standing between the two is CI on that exact commit. Two consequences are worth stating plainly
before enabling this:

- **D1 migrations are forward-only.** The workflow applies them before deploying the Worker. A
  release that includes a migration cannot be undone with `wrangler rollback` alone; see
  [Rollback](DEPLOYMENT.md#rollback).
- **A red CI run blocks the deploy, but a passing one is not proof of a good release.** CI does not
  exercise a live Cloudflare account — no real D1, R2, or Durable Object.

If that trade is not acceptable for an installation, require approval on the production
environment or switch to manual releases; see [Switching to manual releases](#switching-to-manual-releases).

## Triggers

```yaml
on:
  workflow_run:
    workflows:
      - CI
    types:
      - completed
    branches:
      - main
  workflow_dispatch:
    inputs:
      confirm_page_move_receipt_migration_safe:
        type: boolean
```

CI still starts directly on every push. The deploy workflow starts from its `workflow_run`
completion event, eliminating a fixed polling window that could expire while the Chromium job was
still queued or running. A `workflow_run` uses the workflow definition on the default branch; the
deploy job explicitly checks out the triggering run's `head_sha`, not the event's default-branch
SHA. `workflow_dispatch` also becomes available from the default-branch definition, but the person
dispatching it may select another branch or tag as the run's ref.

Before building or changing production, the deploy job asks D1 for its pending migration list. If
`0011_page_move_receipt_envelopes.sql` is pending, automatic deployment fails closed. Apply that migration
only from a manual dispatch after page moves are quiesced, or after verifying that the live Worker already
reads versioned receipts, and check `confirm_page_move_receipt_migration_safe` on that run. The confirmation
is ignored once `0011` is no longer pending, so later automatic deploys resume normally. The gate also
refuses to deploy when Wrangler's migration listing is not in a recognized empty or populated form. Update
the fixtures in `scripts/check-page-move-migration.test.mjs` alongside any intentional Wrangler-output parser
change.

## The release gate

The `gate` job must pass before the `deploy` job starts, rather than running alongside it, because
migrations are forward-only. What it runs depends on how the workflow was triggered:

| Event                      | `pnpm check` in the gate | Deployment condition                                                                  |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| Completed CI run on `main` | Skipped                  | CI passed, its SHA is the current `main` tip, and migration `0011` is not pending     |
| `workflow_dispatch`        | Runs                     | The ref passes; pending `0011` also requires the explicit migration-safe confirmation |

`.github/workflows/ci.yml` triggers on `on: push` with no branch filter, so every push to `main`
starts CI on the same SHA. Its five jobs — static checks, unit, Worker integration, build, and the
Chromium e2e suite — cover everything `pnpm check` does and more, so the automatic path trusts the
completed CI result instead of repeating that suite serially. Failed or cancelled CI completion
events produce no deploy job. Before accepting a successful result, the gate reads the current
`main` ref and skips a superseded SHA; rerunning an old CI job therefore cannot roll production
backward. A dispatched run can name any ref, including one CI never saw, so it runs the full check
itself.

## Credentials

The `deploy` job authenticates Wrangler from repository secrets and probes the deployment using a
repository variable:

| Name                    | Kind     | Purpose                         |
| ----------------------- | -------- | ------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | secret   | Wrangler authentication         |
| `CLOUDFLARE_ACCOUNT_ID` | secret   | Target account                  |
| `PRODUCTION_BASE_URL`   | variable | Post-deploy health probe target |

```sh
pnpm wrangler whoami                                   # read the account ID
gh secret set CLOUDFLARE_ACCOUNT_ID
gh secret set CLOUDFLARE_API_TOKEN
gh variable set PRODUCTION_BASE_URL -b "https://notes.example.com"
gh secret list && gh variable list                     # confirm all three
```

Create an account-owned token under **Manage Account → Account API Tokens**, restrict its account
resources to the target account, and grant only the account permissions this workflow exercises:
**D1 Edit** for migrations and **Workers Scripts Write** for the dry run, deployment, and deployment
listing. The workflow does not run separate Durable Objects, R2, or Workers Observability commands,
so it does not require their standalone permissions. Prefer an account-owned token for CI; a
user-owned token acts as its owner and may stop working if that person leaves the account.

`PRODUCTION_BASE_URL` is required. Before any build, migration, or deploy command, the workflow
fails if the variable is unset or differs from the exact origin configured by production
`BETTER_AUTH_URL` in `wrangler.jsonc`. The health check always probes that origin, so a deploy cannot
succeed without it. The workflow runs `scripts/check-production-origin.mjs`; its validation logic and
Wrangler configuration reader execute in the unit suite, rather than living as untested JavaScript
inside the workflow YAML.

Secrets set with `wrangler secret put --env production` — `BETTER_AUTH_SECRET`, `BOOTSTRAP_TOKEN`,
`DO_LOCATION_HINT` — are not managed by the workflow. They persist across deploys and are set once,
by hand, per [Set secrets](DEPLOYMENT.md#3-set-secrets).

## Concurrency and rapid pushes

The deploy job uses `concurrency: deploy-production` with `cancel-in-progress: false`, so deploys
serialize and a migration never interleaves with another deploy. GitHub holds at most one _pending_
job per concurrency group: during a burst of successful pushes the in-progress deploy finishes
untouched, the newest eligible SHA queues behind it, and intermediate pending jobs are cancelled.
The concurrency scope begins only after the gate, so failed and superseded CI events cannot replace
an eligible pending deployment.

CI sets `cancel-in-progress: true` on its ref. Pushing twice in quick succession cancels the first
CI run; its completion event is skipped, while the newer commit proceeds once its own CI passes and
it is still the tip of `main`.

## Requiring manual approval

The `deploy` job declares `environment: production`, which GitHub creates on first use. To approve
each production release by hand, create that environment ahead of time and add required reviewers;
the job then blocks until a reviewer approves. Environment-scoped secrets and variables also
override repository-level ones, which is the cleaner place to put them once more than one
environment exists.

## Alternative configurations

GitHub Actions is one of four workable shapes. The others are not wrong; they trade differently, and
two of them are constrained by this Worker's Durable Objects in ways worth knowing before choosing.

| Approach                     | Gates on the full suite | Orders D1 migrations | Manual approval | Per-commit preview  | Extra Cloudflare resources  |
| ---------------------------- | ----------------------- | -------------------- | --------------- | ------------------- | --------------------------- |
| GitHub Actions (current)     | Yes                     | Yes                  | Optional        | No                  | None                        |
| Workers Builds               | Not within 20 min       | With a custom token  | No              | Not for this Worker | None                        |
| Gradual deployments          | Inherits its caller     | Caller's job         | Inherent        | Not for this Worker | None                        |
| Staging Wrangler environment | Yes                     | Yes                  | Optional        | A full environment  | A second D1, R2, and DO set |

### Workers Builds

Cloudflare's own Git integration. Connect the repository under **Workers & Pages → the Worker →
Settings → Builds**, pick a production branch, and every push builds and deploys from Cloudflare's
infrastructure with no GitHub Actions involved. The default deploy command is `npx wrangler deploy`;
pushes to non-production branches run `npx wrangler versions upload` instead, creating a version
without promoting it.

Configured for this repository it would need three changes from the defaults:

- A build command that gates the release, since a build only fails on its own command's exit code.
- A deploy command that orders the migration ahead of the deploy:

  ```sh
  npx wrangler d1 migrations apply DB --env production --remote && npx wrangler deploy --env production
  ```

- **A custom API token.** The token Cloudflare generates for builds carries Workers Scripts, Workers
  KV, Workers R2, and Workers Routes edit, plus account and user reads — but no D1 permission at
  all. The migration step fails under the default token. Supply a token carrying D1 Edit under the
  same Builds settings.

What it cannot do here is the gate. Builds are a single container with a hard **20-minute timeout**,
so the suite runs serially where CI runs five jobs in parallel — the Chromium e2e job alone is
allowed 25 minutes. The build image ships no browsers, so Playwright would have to install them
inside that same budget. It also has no equivalent of required reviewers, no post-deploy health
probe, and no way to refuse a commit because a _different_ system's checks failed.

Two smaller mismatches: the build image defaults to Node 24 and ships pnpm 10.11.1, against this
repository's Node 22 and the `packageManager` pin of pnpm 11.18.0. Node pins cleanly with a
`NODE_VERSION` build variable or an `.nvmrc`; confirm which pnpm the install step actually resolves
before trusting a `--frozen-lockfile` install.

Workers Builds is the better choice for a Worker whose entire test suite finishes in twenty minutes.
This one does not.

### Preview URLs do not exist for this Worker

Worth stating plainly, because two of the alternatives are usually sold on it: **"Preview URLs are
not generated for Workers that implement a Durable Object, including Containers and Sandbox
Workers."** This Worker exports `Document` and `WorkspaceEvents`, so `preview_urls: true` in
`wrangler.jsonc` buys nothing here. Any workflow whose review story rests on a per-version URL —
Workers Builds' non-production branch builds, or `wrangler versions upload` for a look before
promoting — does not work as advertised on this project. See
[Configuration](CONFIGURATION.md#worker-settings).

### Gradual deployments

Cloudflare's native answer to having no staging environment: `wrangler versions upload` creates a
version without traffic, and `wrangler versions deploy` splits traffic between versions by
percentage, so a release can be watched at 10% before going to 100%. It is Durable Object aware —
each Durable Object is assigned one version per deployment, that assignment holds until the next
deployment, and requests to a given object always reach the same version.

Two constraints decide whether it is usable here:

- **Lifecycle changes cannot be uploaded as a version.** Versions that change Durable Object class
  lifecycle — the `migrations` array in `wrangler.jsonc`, or the declarative exports field — are
  rejected, because such a change is atomic and cannot be rolled back past. A future third Durable
  Object class ships as an ordinary deploy, never a gradual one.
- **Both versions share one D1 database.** A percentage rollout means old and new code query one
  schema at the same time, which requires expand/contract migrations — each change compatible with
  both revisions — rather than the single-step forward-only migrations this repository writes. Adopt
  that discipline first, or a 10% rollout becomes a 100% outage for whichever version the schema
  does not fit.

Gradual deployment composes with the current workflow rather than replacing it: swap the deploy step
for `versions upload` and promote from a second, manually dispatched workflow. Only the last 100
uploaded versions remain eligible, and consecutive requests from one user can hit different versions
unless version affinity is configured.

### A staging Wrangler environment

The direct fix for the risk this document opens with. Add a third block beside `production` and
`notes-checks-e2e` in `wrangler.jsonc` with its own D1 database, R2 buckets, and `BETTER_AUTH_URL`;
point pushes to `main` at it and keep production on an approved manual dispatch. Durable Object
storage is per environment, so staging traffic never touches production rooms.

It costs a second set of resources, a second migration run per release, and a second set of Worker
secrets. It is the option to take if deploying `main` straight to users is unacceptable but manual
tag releases are too slow.

### Terraform and other infrastructure as code

The Cloudflare provider can manage the Worker, D1 database, and buckets declaratively. This
repository instead declares bindings in `wrangler.jsonc` and creates the resources by hand once, per
[Create resources](DEPLOYMENT.md#1-create-resources). Both owners for one resource is the usual
failure, so adopting Terraform means moving resource creation out of the deployment docs entirely —
worth it across many Workers, not for one.

## Switching to manual releases

Delete the `workflow_run` block and retain `workflow_dispatch`. Manual runs execute `pnpm check`
before entering the serialized production deploy job, and the dispatcher can select a branch, tag,
or commit. This avoids maintaining a second automatic tag path whose pending run could displace a
newer `main` deployment.
