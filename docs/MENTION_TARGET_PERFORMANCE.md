# Mention target tracking measurement

Run `MENTION_BENCH=1 CI=true VITEST_MAX_WORKERS=1 pnpm exec vitest run src/worker/mention-targets.performance.test.ts --reporter=verbose --silent=false` to repeat the local benchmark. It builds 10,000 document blocks or diagram nodes, then measures 25 ordinary edits and 25 structural insertions. These are local measurements, not CI timing limits.

| Kind     | Ordinary edit median | Structural edit median | Incremental tracking median | Former whole-tree scan median |
| -------- | -------------------: | ---------------------: | --------------------------: | ----------------------------: |
| Document |             0.009 ms |               0.151 ms |                    0.115 ms |                      0.240 ms |
| Diagram  |             0.011 ms |               0.008 ms |                    0.004 ms |                      0.316 ms |

The former scan occupied more than 10% of a structural edit in both fixtures. Tracking now updates counts for changed XML top-level subtrees or diagram nodes, and reconstructs them on initial load or when an event cannot identify a changed subtree. Ordinary typing does not scan mention targets. Results vary by machine and document shape; the correctness tests cover duplicate mentions, replacement, removal, and reinsertion.
