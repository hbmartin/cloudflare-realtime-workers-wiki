# Phase 4: offline documents

Status: implemented in #204 and #208 (merged 30 September 2026) and deployed with
`OFFLINE_EDITING_ENABLED=false`. The installable shell and cached catalog ship; offline editing
waits on the two-device and live reconnection pilot. Tables and diagrams remain online in this
phase.

## User contract

After an online visit, the installed NoteFlare app can cold-open its shell and previously viewed
documents without network access. The page list shows the cached title, space, and last synced
time; uncached pages and actions requiring a server are clearly unavailable. A document opens in
an offline state and accepts edits in its existing local Yjs copy. The UI shows pending local
changes, reconnection, and confirmed sync. A browser refresh while offline preserves edits.
On reconnect, the client checks current identity, page access, and document epoch before joining
the room. Successful reconciliation returns to normal editing. If the server rejects access or
the epoch has changed, preserve the local copy in a quarantined draft with export and copy
controls; do not silently merge it into a different page version. Explicit sign-out clears local
document and metadata caches for that account on the device.

## Interfaces and data flow

- Add a versioned service worker for the app shell, fonts, and static assets, plus a manifest and
  install affordance. Cache only same-origin immutable assets and a bounded offline navigation
  fallback. Network API responses are not placed in the general service-worker cache.
- Store an account-scoped IndexedDB catalog of previously opened document IDs, titles, space
  labels, last successful access/sync time, and document epoch. Keep it separate from the
  existing `y-indexeddb` stores keyed by workspace, page, and epoch in
  `src/client/collaboration.ts`. Store only enough metadata to navigate cached documents, not
  the whole workspace tree or permission list. Opening a page online refreshes its catalog
  entry after the access check; offline navigation is limited to catalog entries with a local
  Yjs copy.
- Add an offline boot path in `src/client/App.tsx`: when `/api/me` or workspace metadata cannot
  be reached, select the most recently authenticated local account and show its cached catalog.
  Treat it as device-local content, never as proof of current server access. Disable network
  writes such as sharing, deletion, tasks, comments, imports, and integrations. Show a lock
  screen if no previous account was established on this device.
- Keep edits in the existing Yjs IndexedDB copy and queue only Yjs updates. On reconnect fetch
  `/api/me` and page metadata, confirm account/workspace/epoch and live read/write access, then
  connect the provider and wait for the server sync acknowledgment before marking edits synced.
  If the member is read-only, quarantine pending writes while allowing current server content
  to be read separately. The quarantine retains the old epoch key and offers a Markdown export;
  importing it later requires an explicit user action and fresh permission check.
- Sign-out revokes the server session online when possible and locally clears the catalog,
  `y-indexeddb` page stores, and service-worker account-specific state for that account before
  showing the signed-out screen. Clear even when the server is unreachable. Switching accounts
  never displays another account's cached titles or content. Storage eviction is detectable and
  yields an empty offline catalog rather than a broken page.

## Migration, rollout, and recovery

No server content migration is needed. Version the local catalog and service-worker caches;
upgrade an existing Yjs store in place, and leave an unreadable prior version quarantined for
export instead of deleting it. Roll out shell caching first, then catalog navigation, then
offline editing behind a client flag. Use a two-device and two-tab pilot; make sync status derive
from actual provider acknowledgment, not browser `online` events. A bad service-worker release
can be retired by a new worker and cache version without deleting document IndexedDB. Document
content remains available in its last local copy until explicit sign-out or browser storage
eviction; explain that limitation in the offline UI.

## Exit matrix

| Scenario                                                          | Required result                                                              |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Install, visit two documents, close, disconnect, cold reopen      | Shell, catalog, and both documents render without network                    |
| Edit offline, refresh, reconnect with same epoch and write access | One reconciled document; pending indicator clears only after sync            |
| Epoch change, write revocation, or account switch during outage   | No unauthorized sync; old edits retained in quarantined export               |
| Explicit sign-out while offline                                   | Account catalog and Yjs copies are purged locally                            |
| Service-worker upgrade and storage eviction                       | Upgrade reopens content or offers export; eviction has an honest empty state |
| Open a table or diagram while offline                             | Clear online-required state; no false editable copy                          |
| Offline boot, API recovery, and repeated reconnect                | No cached API response treated as authorization; Yjs changes sent once       |
