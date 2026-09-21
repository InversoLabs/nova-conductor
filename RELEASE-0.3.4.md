# Nova Conductor 0.3.4 — pre-workflow snapshot

Preserves the current coding workflow before development of customizable templates.

- Original user request included in every role prompt.
- Planner document ownership clarified; runtime errors excluded from worker guidance.
- Initial implementation, reviewer repairs, and manual user changes have distinct builder instructions.
- Existing codebases can be imported into an isolated Builder workspace.
- Narrow Gemma E2B bare-patch compatibility, with native Codex replay verification.

Validation: 41 automated tests passed; two opt-in native tests were separately passed during Gemma compatibility work. This is a recoverable development baseline, not a claim that every local model completes projects reliably. Protected-file violations still stop runs, and prompt compliance remains model-dependent.

The public launcher supports configurable providers. The owner's installed desktop launcher retains its existing NOVA-specific connection setup; provider credentials and private runtime state are not in this release.
