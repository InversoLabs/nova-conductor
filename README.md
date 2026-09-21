# Nova Conductor

Double-click **Start Conductor.cmd**, choose **1**, and enter your project name,
prompt, and installed NOVA model. A separate **native Codex terminal** opens for
the active role. Conductor's menu window shows the phase and remains the owner
of the run. Closing the Codex display alone does not stop the work; use menu
option **4** in another launcher window, or Ctrl+C in the Conductor window.

Projects live in `Documents\Nova Conductor Projects\NAME-TIMESTAMP`.
The actual product is in `work`. Keep NOVA-SERVER and its bridge running.
Only one model session runs at a time, using your launcher's existing mutex.

## The workflow

1. A fresh **Planner** creates project-specific `AGENTS.md` and `BUILD_PLAN.md`.
2. A fresh **Builder** implements the plan and records work in `BUILD_NOTES.md`.
3. A fresh **Reviewer** checks the product read-only against `REQUEST.md` and the plan.
4. If incomplete, the reviewer returns ordered actions and verification steps;
   Conductor writes them to `BUILD_CHECKLIST.md`. A fresh builder works through them, then review repeats.
5. A reviewer PASS plus successful configured independent checks ends the run. A PASS contradicted by checks returns to a fresh reviewer to write the missing repair checklist.

Every role uses `thread/start` with a new thread ID and a 16,384-token context.
The terminal uses `codex --remote ... resume ID` solely to attach to that new
thread; it does not reuse the preceding role's history. Codex itself renders
its output, tools, colors, and any reasoning summaries it exposes. Conductor
does not synthesize thinking text or replace the terminal with a JSON log view.

Handoffs are files, not copied transcripts. `REQUEST.md` remains authoritative.
The reviewer returns a final Markdown message beginning with `# PASS` or `# REVISE`, followed by evidence and, for revisions, a `## Checklist` section. Conductor saves `REVIEW.md` and replaces `BUILD_CHECKLIST.md`; the reviewer has a read-only sandbox. There is no JSON completion report and no formatting-agent loop.
If a role fails twice to produce usable artifacts, Conductor stops for attention.
New projects use sixty role sessions and a ten-minute per-role deadline. Builders work on at most three checklist items per turn. A timed-out builder is stopped before a fresh reviewer receives its preserved files and independent check results. At most three deadline recoveries are allowed. Three completed builder attempts without product changes stop for attention. Existing project deadlines are preserved. Continue also recovers projects stopped by the older builder-deadline behavior.

Codex first applies its built-in stream retries. If those fail, Conductor
preserves partial files and retries the same role in a fresh 16K session after
5, 10, and 20 seconds (three recovery attempts). Disconnects have a separate
budget from malformed handoffs. If the controller socket is lost, the owned
server/worker tree is stopped before retrying, to avoid duplicate builders.
The proxy repairs tool arguments; it does not replay partially delivered streams.

## Verification and limits

The planner chooses acceptance checks appropriate to the request; new projects have no mandatory test framework. You may enter additional command argv arrays when creating a project. Existing projects keep their configured checks, and explicitly requested tests remain requirements. Zero discovered Node tests does not count as success when Node verification is configured. An empty extra-command list is not evidence of product correctness: the reviewer must still execute and document the planned acceptance checks. No browser automation is added by this update. Verification runs outside the model sandbox on your trusted generated
project, with a two-minute command limit. Reviewers must also inspect the actual
behavior; tests alone do not prove a polished or complete product.

Planner/reviewer file boundaries are checked after each turn. Unexpected changes
are preserved and stop the run; Conductor never silently rolls them back.
Planner and builder use Codex workspace-write permissions; reviewer uses read-only permissions. Package downloads can still be
restricted by your configured Windows sandbox. This version does not widen it.
An interrupted process with unrecorded changes may require inspection before
resume; it does not silently adopt outside edits.

The Codex app-server/remote interface is experimental in the installed CLI.
This package is a Windows integration using Node 22+, PowerShell, Git, Codex,
and your existing NOVA-SERVER SSH setup. It reuses the NOVA model catalog,
launcher/provider settings, model warm-up, and compatibility proxy including
apply_patch and narrow exec_command argument repairs. The app server binds
only to loopback port 8799; the proxy uses 8788.

The launcher reads your existing `NOVA_DESKTOP_API_KEY` environment variable or
`Desktop\codex\nova_key.txt`; it does not copy credentials into projects.
State, event history, checks, and phase prompts are stored outside `work`.
Codex retains its native session history in the existing isolated NOVA home.

## CLI

```powershell
node src/conductor.mjs init PROJECT PROMPT_FILE gpt-oss:20b
node src/conductor.mjs run PROJECT
node src/conductor.mjs status PROJECT
node src/conductor.mjs stop PROJECT
```

Use the menu for automatic proxy startup and private key loading. The direct
CLI expects those prerequisites already available. Resume a stopped project
with `run`; completed projects are not reopened automatically. To retry after
the two-failure limit, inspect the failure and adjust `failures` in state only
while stopped. Existing Director projects are preserved separately and are not
silently converted into Conductor projects.

Run `npm test` for controller and role-boundary regression tests. Integration
testing must also verify the real model and the native terminal; deterministic
tests alone do not establish model quality or end-to-end product success.

Interrupting a worker turn in the native Codex window pauses that role and keeps the session open for your next message. The role deadline pauses while waiting. Submit guidance in that window to continue. Conductor Stop or Ctrl+C in its controller window still ends the run.

Reviewer deadlines stop for attention instead of launching the same review repeatedly. The original request controls scope; optional suggestions do not block acceptance.

Continue on a stopped or failed run resets per-attempt failure counters after checking file integrity; the total run budget remains. An incomplete reviewer response gets one request for clarification in the same session. Raw review responses are saved under runs for diagnosis.

To reopen a completed project with feedback, choose menu 7, select the project, choose Planner, Builder, or Reviewer, and enter optional guidance. It starts a fresh session at that phase. CLI: node src/conductor.mjs reopen PROJECT ROLE FEEDBACK_FILE, then node src/conductor.mjs run PROJECT. Existing product files are preserved; prior review/checklist/state are archived. Reopening grants at least ten remaining role sessions when the prior run budget is exhausted.
