# Continuous deployment

`.github/workflows/deploy.yml` deploys the production Worker on every push to `main`, on a pushed
`v*` tag, and on manual `workflow_dispatch`. This document covers what that trigger implies, the
gate that protects it, and the account credentials it needs.

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

If that trade is not acceptable for an installation, revert to tag-only releases; see
[Reverting to tag-only releases](#reverting-to-tag-only-releases).

## Triggers

```yaml
on:
  push:
    branches:
      - main
    tags:
      - "v*"
  workflow_dispatch:
```

A change to this file takes effect only once it is on `main`.

## The release gate

The `gate` job must pass before the `deploy` job starts, rather than running alongside it, because
migrations are forward-only. What it runs depends on how the workflow was triggered:

| Event                        | `pnpm check` in the gate | CI on the same commit                             |
| ---------------------------- | ------------------------ | ------------------------------------------------- |
| Push to `main` or a `v*` tag | Skipped                  | Required; must conclude `success`                 |
| `workflow_dispatch`          | Runs                     | Used if one exists; a missing run is not an error |

`.github/workflows/ci.yml` triggers on `on: push` with no branch filter, so every push to `main`
starts CI on the same SHA. Its five jobs — static checks, unit, Worker integration, build, and the
Chromium e2e suite — cover everything `pnpm check` does and more, so repeating `pnpm check` serially
ahead of each deploy would add roughly twenty minutes per push for no additional coverage. A
dispatched run can name any ref, including one CI never saw, so the full check runs there instead.

The gate polls the CI run for its commit twenty times at sixty-second intervals. A commit whose CI
concluded anything other than `success` is refused. For a push, a CI run that never appears is also
refused after the poll window; only a dispatched ref may deploy with no CI run at all, and that path
is covered by the `pnpm check` it ran itself.

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

Create the token under **My Profile → API Tokens → Create Token** from the **Edit Cloudflare
Workers** template, then confirm it carries the permissions listed in
[Prerequisites](DEPLOYMENT.md#0-prerequisites) — Workers Scripts Edit, D1 Edit, R2 Edit, Workers
Observability, and account-level Durable Objects — and add any the template omits. A token missing
D1 Edit fails at the migration step, after the gate has passed and before the Worker is deployed.

`PRODUCTION_BASE_URL` is not optional in practice. The health-check step is guarded by
`if: vars.PRODUCTION_BASE_URL != ''`, so an unset variable produces a green deploy that was never
probed. Set it to the exact origin in the production `BETTER_AUTH_URL`.

Secrets set with `wrangler secret put --env production` — `BETTER_AUTH_SECRET`, `BOOTSTRAP_TOKEN`,
`DO_LOCATION_HINT` — are not managed by the workflow. They persist across deploys and are set once,
by hand, per [Set secrets](DEPLOYMENT.md#3-set-secrets).

## Concurrency and rapid pushes

The deploy workflow uses `concurrency: deploy-production` with `cancel-in-progress: false`, so
deploys serialize and a migration never interleaves with another deploy. GitHub holds at most one
*pending* run per concurrency group: during a burst of pushes the in-progress deploy finishes
untouched, the newest push queues behind it, and intermediate pending runs are cancelled. Production
therefore converges on the newest commit rather than replaying every commit in the burst.

CI, by contrast, sets `cancel-in-progress: true` on its ref. Pushing twice in quick succession
cancels the first CI run, and the deploy waiting on that commit sees a `cancelled` conclusion and
fails. This is the gate working as designed — it refuses to ship a commit whose checks did not
pass — but it surfaces as a failed workflow run for a commit that was simply superseded. Production
is unaffected and the newer commit deploys normally.

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
probe, and no way to refuse a commit because a *different* system's checks failed.

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
point pushes to `main` at it and keep `v*` tags for production. Durable Object storage is per
environment, so staging traffic never touches production rooms.

It costs a second set of resources, a second migration run per release, and a second set of Worker
secrets. It is the option to take if deploying `main` straight to users is unacceptable but manual
tag releases are too slow.

### Terraform and other infrastructure as code

The Cloudflare provider can manage the Worker, D1 database, and buckets declaratively. This
repository instead declares bindings in `wrangler.jsonc` and creates the resources by hand once, per
[Create resources](DEPLOYMENT.md#1-create-resources). Both owners for one resource is the usual
failure, so adopting Terraform means moving resource creation out of the deployment docs entirely —
worth it across many Workers, not for one.

## Reverting to tag-only releases

Delete the `branches` block from the `push` trigger. Releases then happen only on a pushed `v*` tag
or a manual dispatch, and the rest of the gate continues to behave correctly: a tag push also starts
CI on that commit, so the wait still finds a run to require.
