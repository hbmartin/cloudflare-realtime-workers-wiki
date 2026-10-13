# Third-party notices

NoteFlare is licensed under AGPL-3.0. It depends on or adapts ideas from the following projects. Their licenses remain applicable to their respective works.

## BlockNote

BlockNote core, React, and Mantine packages are used as dependencies under MPL-2.0. No `@blocknote/xl-*` package is used.

Copyright BlockNote contributors. Source: <https://github.com/TypeCellOS/BlockNote>

## PartyServer and y-partyserver

Used as dependencies under the ISC license.

Copyright PartyKit contributors. Source: <https://github.com/partykit/partykit>

## Yjs, y-indexeddb, y-prosemirror, and y-protocols

Used as dependencies under the MIT license.

Copyright Yjs contributors. Source: <https://github.com/yjs/yjs>

## React Flow

The `@xyflow/react` package is used as a dependency under the MIT license. No
React Flow Pro examples or packages are included.

Copyright webkid GmbH and React Flow contributors. Source: <https://github.com/xyflow/xyflow>

## Docmost

The pure page-tree model and fractional page ordering were adapted from Docmost’s AGPL-3.0 implementation and tests. This repository is also AGPL-3.0.

Copyright Docmost contributors. Source: <https://github.com/docmost/docmost>

The formula parser, resolver, typechecker, dependency graph, formatter, evaluator,
and deterministic function implementations in `src/shared/formula/` are adapted
from `packages/base-formula/src` at commit
`c1305f002e47ece4d40f0aebba75d8d0f762d8ea` under AGPL-3.0. Changes include strict
argument/condition validation, non-finite errors, scalar-only inputs, the selected
20 functions, stable IDs, and one browser/Worker entry point. Editor tabs, status,
footnote identity and presentation helpers adapt portable AGPL core editor code
from the same commit. Commercial `/ee` code is excluded.

Find/replace matching and replacement adapt
`packages/editor-ext/src/lib/search-and-replace/search-and-replace.ts` at that
commit under its explicit MIT license, copyright (c) 2023–2024 Jeet Mandaliya.
The complete MIT notice is retained in `src/client/find-replace.tsx`.

## AFFiNE

Grouped insertion defaults and typed column calculation algorithms adapt
`blocksuite/affine/data-view/src/core/filter/generate-default-values.ts`,
`view-presets/kanban/kanban-view-manager.ts`, and `core/statistics/{any,number}.ts`
at commit `0b69a6da21e8fd35beb85667bb8496d9b3852238` under MIT. Adaptations use
NoteFlare's table authority, scalar boundaries, whole filtered sets, and typed
results. Linked-card behavior and deletion scenarios reference the MIT frontend
model/tests from that commit. No upstream editor/canvas runtime or backend is included.

Copyright AFFiNE contributors. Source: <https://github.com/toeverything/AFFiNE>

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## tldraw-sync-cloudflare

Cloudflare Vite, Workers Static Assets, Durable Object migration, and R2 response patterns were used as a reference under MIT. No tldraw SDK code or protocol is included.

Copyright tldraw contributors. Source: <https://github.com/tldraw/tldraw-sync-cloudflare>

## Better Auth, Hono, React, Mantine, and fractional-indexing-jittered

Used as unmodified package dependencies under their published licenses. See `pnpm-lock.yaml` and each installed package for exact versions and notices.

Outline commit `b4bef2c0141c73ba260040bbbdba3ee1add6d752` was consulted only as
a behavioral reference. No current Outline BSL source or fixtures were copied.
No AFFiNE branding or assets are included.

## Mammoth, docx, and htmlparser2

Mammoth is used for Word import under BSD-2-Clause. Copyright Michael Williamson.
Source: <https://github.com/mwilliamson/mammoth.js>

docx is used for Word export under MIT. Copyright Dolan and docx contributors.
Source: <https://github.com/dolanmiu/docx>

htmlparser2 is used for semantic HTML parsing under MIT. Copyright Chris Winberry
and htmlparser2 contributors. Source: <https://github.com/fb55/htmlparser2>

See each installed package for its complete license text and notices.
