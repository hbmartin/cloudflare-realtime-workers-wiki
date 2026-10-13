# Editor implementation and release evidence

These changes are implemented in the local working tree. They have not been deployed or enabled in a production workspace. The repository release checklist and complete `pnpm check` remain release requirements.

## Readers before creation

Every editor schema loads the new readers, including the offline document editor and presentation snapshot. `EDITOR_BLOCKS_V2_ENABLED` defaults to false in every Wrangler environment. `/api/me.features.editorBlocksV2` controls creation of status badges, tabs, footnotes, linked database blocks and diagram page cards. Turning it off preserves rendering and editing of existing content; it does not rewrite documents.

Document clients advertise `native-tables-v1,tabs-v1,footnotes-v1,status-badges-v1,linked-table-views-v1,diagram-links-v1` in the WebSocket `editorCapabilities` parameter. The Document Durable Object checks the current canonical tree before accepting a writer message. Clients missing any required reader capability become read-only, including when a new feature arrives after connection. The `document-schema-upgrade` message shows a reload prompt. Diagram links use the corresponding diagram capability. Server validation and capability enforcement are independent of the creation flag.

The native BlockNote table row schema includes non-rendered `apiRowId`, so tables created through the Notion API reopen and retain row identity through collaborative edits. Editor and offline render boundaries preserve history/recovery-copy controls and report `client.render_failed`. Startup, plugin and presentation boundaries contain failures at their own view boundary.

A pinned pnpm patch for BlockNote core 0.55.0 carries `apiRowId` through high-level table conversions, occupancy-grid edits and cropping in both shipped runtime formats. Table edits and moves retain surviving IDs; inserted copies receive fresh IDs. The patch includes source and declarations and is recorded in the lockfile.

## User behavior and formats

Find and replace searches literal body text across formatting runs and hidden tab content. Match-case and Unicode whole-word options are supported. Inline atoms and paragraph boundaries stop matching. Navigation reveals the selected tab; replacements inherit the first matched text's marks and replace ranges from the end. Replace and replace-all form separate Yjs undo groups. Search UI state is local, and closing it clears decorations. Queries are capped at 200 characters and results at 10,000; the UI states when replacement covers only the displayed set.

Status badges are inline atoms with a label up to 200 characters and gray, blue, green, yellow, red or purple color. Tabs have stable block IDs, one to twenty panels, editable labels, local active-panel state and keyboard navigation. Rename, reorder, duplicate and confirmed removal are implemented; removing the last panel is blocked. Hidden content remains in the canonical document. Copies get fresh block identities and remap carried footnote definitions/references; standalone references retain their targets. Internal drag moves and tab reorder preserve identities. Tab operations retain actual ProseMirror nodes so native table row IDs in untouched panels survive add, reorder, duplicate and removal; copied rows receive new API identities.

Footnotes store stable `definitionId` values instead of mutable numbers. Numbers follow first-reference order across the complete document, including hidden tabs. Definitions use rich inline content. Reference and back-reference buttons navigate to each other; missing definitions can be created from their references, and unreferenced definitions remain labelled unused. Markdown and HTML imports allocate request-local identities and preserve repeated references, formatting, escaped Markdown syntax and multiline definition content.

Footnote-like text inside code blocks stays literal. Headless code-block validation matches the editor's text-only content while retaining comment annotations. Local insertion, paste, drop and indentation cannot introduce nested tabs; received Yjs updates retain their collaboration semantics.

Markdown export flattens all tabs with their labels, emits readable status text and stable `[^id]` footnote references/definitions. HTML provides labelled tab content and matching footnote anchors. Word exports preserve readable status, tab and footnote content. Native editor/Yjs round trips retain full structure. Portable exports do not promise restoration of interactive tab/status controls from their readable representation.

Presentation captures a read-only document snapshot. It uses a title slide, measured blocks, H1/divider breaks, standalone tables and scrollable oversized blocks. Arrow/PageUp/PageDown navigation, focus containment, Escape, fullscreen and resize/image/font remeasurement are supported. Tab controls work locally inside the snapshot. Presentation does not write to the source document. Page removal unmounts its portal and restores shell access; source epoch or edit-permission changes discard the private snapshot. The title is frozen with the body. The launcher explicitly takes focus so Safari also restores focus to it on close.

Linked table blocks point to actual source table/view IDs. They reuse the shared Grid/Board/Calendar renderer through host-scoped query and command endpoints; host and source permissions are checked separately. Empty view ID selects the all-rows Grid. Diagram cards point to page and optional source-view IDs, with an explicit node-label alias. Read-only previews use pooled ACL-checked requests, bounded text/rows, immediate cached-preview invalidation on permission/source notifications, and a generic unavailable state after denial. Source edits and titles are read from canonical authority rather than stale D1 text. Saved table view selection requires the migrated table authority.

Page info paginates contributors without duplicates and shows created/edited identities and document word count. Incomplete older history and limited text coverage are labelled. Offline edits are attributed to the authenticated member who syncs them.

## Rendering evidence

The actual ProseMirror document and every editable block remain mounted. KaTeX, Mermaid, bookmarks, synced references, live diagrams, linked tables and card previews pause expensive work outside a 600px viewport margin and in hidden tabs. Selection, focus and IME composition keep the active renderer ready. Placeholder sizing uses observer-provided geometry and retains measured height. Shiki highlights only visible/selected code, caches unchanged nodes and suspends during composition. The table of contents maintains a heading index from changed blocks; unrelated paragraph edits do not rescan the full document.

A controlled browser comparison uses the same working tree with eager observers disabled versus normal deferred observers. The profile is 97% paragraphs, 1% H2 headings, 1% JavaScript blocks and 1% KaTeX blocks, at 1280×800. Shiki is warmed, mode order alternates, and each case runs three times. It measures construction through three animation frames and one paragraph edit through two frames. It is a development-server comparison, not historical commit evidence or production latency.

| Blocks | Mount eager / deferred median | Edit eager / deferred median | Offscreen math and code previews eager / deferred |
| ------ | ----------------------------- | ---------------------------- | ------------------------------------------------- |
| 1,000  | 50 / 50 ms                    | 33 / 33 ms                   | 10 each / 0                                       |
| 5,000  | 226 / 216 ms                  | 35 / 20 ms                   | 50 each / 0                                       |
| 10,000 | 527 / 591 ms                  | 39 / 22 ms                   | 100 each / 0                                      |

All eighteen samples retained exactly the requested number of native blocks; preview computation did not change document content. The 10k mount median increased by 12%, while edit median decreased by 44%. This supports reduced ongoing preview work and larger-document edit latency; it does not establish a universal mount-speed improvement. The fixture places its heavy blocks beyond the initial viewport and does not benchmark network previews or Mermaid. Raw samples are in `editor-rendering-measurements.json`.

Reproduce with `pnpm exec playwright test tests/e2e/editor-rendering.spec.ts --project=chromium`. Fresh measurements are written to `/tmp/noteflare-editor-rendering.json`; update this evidence deliberately after reviewing them.

## Validation and provenance

Real-schema unit tests cover formatting/whole-word matching, marked replacement/deletion, native Yjs round trips, local tab selection and search reveal, copy identity and drag-move preservation, request-local Markdown/HTML footnotes, escaped syntax, multiline HTML definitions, heading updates and measured pagination. Recovery tests cover renderer retry/history/export, contributor paging, preview pooling/revocation, viewport focus and IME. A real ProseMirror view tests deferred Shiki highlighting, unchanged canonical text and composition boundaries. Existing import tests remain in the scoped run.

Browser acceptance exercises native Notion table create/reopen and stable rows, two-client tab search/replace/undo, presentation resize, middle-block slash conversion and native whole-block deletion/undo, status/footnote edit/navigation/convergence/reopen with creation disabled, and diagram card titles/aliases/denied-preview clearing. The final aggregate run on 2026-10-13 passed all six scenarios in Chromium, Firefox and WebKit, together with two table authority scenarios: **24/24 passed**. Expanded tab operations (add, rename, move, duplicate and confirmed removal) preserve native row identities. Earlier caret selection and Safari launcher focus findings were corrected before this run.

A Firefox test interception race was corrected by draining active `/api/me` route handlers before reloading with creation disabled. The trace showed an old handler completing after reload had begun. That test-only fix passed nine repetitions across the three browsers, with retries disabled, before the final aggregate run.

Final command: `pnpm exec playwright test tests/e2e/editor-features.spec.ts tests/e2e/table-authority.spec.ts --project=chromium --project=firefox --project=webkit`. The editor scoped unit run passed 198 tests across five suites; scoped lint and client/config checks passed. Repository-wide evidence is recorded in [release.md](release.md).

The PR #253 review-fix rerun on 2026-10-13 also passed **24/24** browser scenarios, including the shipped native table row-extension control, stable API row IDs after collaborative reopening, and slash insertion inside a tab panel. Additional real-editor regressions cover blank collaborative startup, identical-content row moves, copy remapping, undo/redo, code-block import validation and local nested-tab prevention. Final repository client checks passed **2,404 unit tests** with one existing skip; the preceding `pnpm check` passed **1,970 Worker tests**, static checks and both production builds. See [table-authority-release.md](table-authority-release.md) for the authority and control regression evidence.

Browser logs still contain BlockNote viewport and non-textblock selection warnings, navigation-time canceled-request diagnostics, and an intermittent ResizeObserver notification warning. Acceptance assertions passed; this evidence does not claim clean browser diagnostics or production acceptance.

Docmost core adaptations are pinned to `c1305f002e47ece4d40f0aebba75d8d0f762d8ea` under AGPL-3.0: portable tabs/status/footnote identity and presentation helpers. Find/replace adapts `packages/editor-ext/src/lib/search-and-replace/search-and-replace.ts` with its MIT copyright notice for Jeet Mandaliya retained in the implementation. Diagram linked-card behavior references AFFiNE's MIT frontend model/tests at `0b69a6da21e8fd35beb85667bb8496d9b3852238`; no upstream canvas runtime is included. `THIRD_PARTY_NOTICES.md` records repository provenance. Commercial `/ee` implementations are excluded.

Trash retention, editable virtualization, relation/rollup UI and cross-table computation are outside this implementation. Production migration, deployment SHA, feature enablement and production acceptance remain separate release work.
