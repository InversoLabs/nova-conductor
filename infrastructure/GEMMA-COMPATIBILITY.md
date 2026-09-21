# Gemma E2B patch compatibility

`gemma-patch.cjs` automatically handles one observed provider failure for `gemma4:e2b-it-qat` and `gemma4:e2b`: a completed assistant answer containing only an Add File patch instead of a native `apply_patch` call.

The request must explicitly offer the custom `apply_patch` tool and permit its selection. The response must finish successfully, contain exactly one assistant message, and contain no native calls. Only complete, unfenced Add File patches with safe relative paths and plus-prefixed content are accepted. Repeated End Patch markers between separate file additions are merged without changing file content. Updates, deletions, prose, shell text, truncated patches, mixed tool output, and duplicate paths are left alone. Buffering is bounded; interrupted/oversized streams are passed through without execution.

Conversion produces normal Codex tool events. Codex still executes the tool under its existing workspace permissions and reports its result. The proxy does not write files or claim execution succeeded. GPT-OSS, Ornith, Gemma 12B, and other models bypass this adapter.

Evidence: the first GEMMA2B_TEST_1 response from 2026-09-21 printed two document patches as plain assistant text. Its second response was incomplete and is intentionally not repaired. The first response also contained a generic, unsuitable plan: transport repair does not validate plan quality or ensure task completion.

Verification: recorded-response replay, fragmented SSE and fail-closed regressions, full Conductor tests, and native Codex execution against a deterministic provider in an isolated temporary workspace. No complete live Gemma project success is claimed by these tests.
