# Security policy

## Reporting

Please report suspected vulnerabilities privately to the repository maintainers rather than opening a public issue. Include affected revision, reproduction steps, impact, and whether the report contains sensitive workspace data. Maintainers should acknowledge a complete report within seven days.

## Supported version

Until the first stable release, only the latest commit on the default branch receives security fixes.

## Security boundaries

- Membership and roles are checked in the Worker for every application resource and before every WebSocket upgrade.
- Viewer Yjs writes are rejected again inside the Durable Object.
- PartyServer internal identity headers are stripped and replaced by the Worker.
- Connection grants expire after five minutes; role revocation is effective on the next authorization.
- Invite credentials are one-use SHA-256 hashes with a seven-day lifetime.
- Files use server-generated private R2 keys and authorized streaming responses. Active HTML/SVG/script content is rejected.
- Titles, trees, comments, search, and table cells are private workspace data. Do not include secrets in them.

## Deployment responsibilities

Operators must use a strong `BETTER_AUTH_SECRET`, protect and rotate `BOOTSTRAP_TOKEN`, keep `BETTER_AUTH_URL` on the exact HTTPS origin, restrict Cloudflare account access, monitor Worker/D1/R2/DO logs and metrics, and maintain backups. Email verification and forgotten-password delivery are deliberately out of scope; owners revoke and reinvite accounts when necessary.

The location hint for a workspace is an optimization, not a formal data-residency boundary. D1 and other Cloudflare metadata are not constrained by the page Durable Object hint.
