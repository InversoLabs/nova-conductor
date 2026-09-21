# Nova Conductor

Give Conductor a prompt. A planner writes the project instructions and build
plan, a builder implements it, and a reviewer checks the result. When it needs
work, the reviewer supplies a concrete checklist for the next builder session.
Each role starts a fresh 16K Codex session, with files carrying the handoff.

**NOVA Desktop and SSH are not required.** Conductor includes its launcher and
compatibility proxy. Use Ollama, LM Studio, an existing NOVA bridge, or another
Responses API provider. Native Codex renders the terminal, tools, colors, and
reasoning summaries the selected model/provider exposes.

## Download and run on Windows

1. Install [Node.js 22 or newer](https://nodejs.org/), [Git for Windows](https://git-scm.com/downloads/win), and the [Codex CLI](https://developers.openai.com/codex/cli/).
   The tested Codex version is **0.155.1**. Install it with:
   ```powershell
   npm install -g @openai/codex@0.155.1
   ```
2. Start your model server and load a model that supports tool calling.
3. Download this repository using **Code → Download ZIP**, then extract it.
   Alternatively: `git clone https://github.com/InversoLabs/nova-conductor.git`.
4. Double-click **Start Conductor.cmd**. No `npm install` is needed in this folder.
5. Choose **8 — Provider settings**, select your server, and enter its API URL.
6. Choose **1 — New project**, enter a name and prompt, and select a model from
   the server's list (or enter its exact model ID).

This release uses Windows PowerShell and native Windows process management.
macOS/Linux launchers are not included. Conductor does not bundle Codex, a model,
or a model server. Local providers do not need a ChatGPT login or NOVA API key.

## Providers

| Selection | Default API URL | Setup |
| --- | --- | --- |
| Ollama | `http://127.0.0.1:11434/v1` | Start Ollama and pull a tool-capable model. Use a current version with Responses API support (introduced in 0.13.3). |
| LM Studio | `http://127.0.0.1:1234/v1` | Load a tool-capable model, then start its local API server. |
| Other | Enter your provider's URL | Must implement `/responses` with streaming and Codex-compatible tools. `/models` enables model discovery. |
| NOVA bridge | `http://127.0.0.1:8787/v1` | Optional existing bridge. Enter its address and key environment variable. |

URLs may point to another machine on your network. Include the API base path,
usually `/v1`; do not enter the `/responses` or `/models` suffix. Providers that
only implement `/chat/completions` are **not supported** by this release.

Configure the model server for **at least 16,384 context tokens**. Conductor's
client context setting does not resize the server's model context. In LM Studio,
set context length when loading the model. For Ollama, use its context setting
or a Modelfile with `PARAMETER num_ctx 16384`. Larger coding projects may exceed
this deliberately small context budget. See [Ollama's API documentation](https://docs.ollama.com/api/openai-compatibility)
and [LM Studio's Responses API](https://lmstudio.ai/docs/developer/openai-compat/responses).

For an authenticated provider, save the **environment variable name**, not the
key. For example, use `MY_MODEL_API_KEY`. Set that variable before launching, or
the menu will ask for the key privately when a project starts. Model discovery
needs the variable already set; manual model entry works when discovery fails.
Keys are not written to provider settings or project state. Use HTTPS when
sending credentials beyond a trusted local network.

Defaults are stored in `%LOCALAPPDATA%\NovaConductor\provider.json`.
Each new project saves its own provider and model settings. Changing the default
does not redirect existing projects. Choose **9 — Change project provider** to
change a stopped project's provider and model. Old projects without provider
settings retain their legacy NOVA endpoint until migrated with this option.

## Included proxy and native Codex

Conductor starts a private loopback proxy on an available port for each run and
stops it with the worker. The upstream API key stays in the controller process;
the Codex child receives a separate temporary token for the local proxy.
The proxy repairs supported malformed `apply_patch` and `exec_command` arguments
without inventing commands or changing permissions. For Ollama and LM Studio,
it translates Codex's freeform patch tool to a function tool and translates
the streamed result back. Other Responses providers receive request fields
unchanged; response argument repairs still apply.

The app server listens on loopback port 8799. Only one Conductor model session
runs at a time. Codex uses `%LOCALAPPDATA%\NOVA-Codex`, separate from your usual
settings. On a fresh installation, the launcher enables Codex's Windows
`unelevated` restricted-token sandbox; existing configuration is preserved.
Planner and builder use workspace-write; reviewer uses read-only. Package
downloads may be restricted by the sandbox. No full-access bypass is enabled.

## Workflow and controls

Projects live in `Documents\Nova Conductor Projects\NAME-TIMESTAMP`.
The generated application is in the project's **work** folder.

1. Planner creates `AGENTS.md` and `BUILD_PLAN.md` against `REQUEST.md`.
2. Builder implements the plan and records `BUILD_NOTES.md`.
3. Reviewer checks requirements and returns `# PASS` or `# REVISE` with evidence.
4. Conductor saves `REVIEW.md`; revisions become `BUILD_CHECKLIST.md` for a fresh builder.
5. A reviewer PASS plus successful configured independent checks completes the run.

The planner chooses appropriate checks; there is no mandatory test framework.
Optional verification commands can be supplied as JSON argv arrays at creation.
Those commands run outside the model sandbox against the generated project with
a two-minute timeout. Tests do not establish visual quality; reviewers still
need to inspect behavior and acceptance requirements.

- **Continue (2)** resumes a stopped run using its files.
- **Stop (4)** stops the active run. Ctrl+C in the controller also stops it.
- **Reopen (7)** lets you choose Planner, Builder, or Reviewer and supply guidance.
  Product files are preserved; previous review/checklist/state are archived.
- Interrupting a worker turn in the native Codex window pauses the role. Enter
  guidance there to continue the same session. Closing the display alone does
  not stop the controller; use Stop.

New projects allow sixty role sessions, 45 minutes per builder and 30 minutes
per planner/reviewer, three disconnect
recoveries, and three builder deadline recoveries. A timed-out reviewer stops
for attention. Disconnect retries preserve partial files and start a fresh role
session after 5, 10, and 20 seconds. The proxy does not replay partial streams.
Role/file boundaries and outside edits are checked; unexpected changes are
preserved and stop the run. The app-server/remote interface is experimental;
use the tested Codex version when diagnosing regressions.

Existing projects using the old ten-minute default migrate to these longer
deadlines on their next run. Already-running controllers must be stopped and
restarted to load the update. Custom deadlines remain unchanged. These are
role deadlines, separate from provider/network disconnect handling.

Builders also have a progress watchdog: four minutes without tool activity or
eight minutes without product-file changes triggers a fresh builder with a
focused instruction to implement the smallest unfinished step. Active tools and
user pauses suspend these checks; handoff-note edits do not count as product
progress. One automatic recovery is allowed, then the run stops for attention.
Disconnects with no product changes share that recovery budget. Actual product
progress in a completed builder resets it; Continue/Reopen starts a new attempt.
Project config can override `builderIdleMs` and `builderNoChangeMs`. Tool activity
metadata and stall reasons are recorded in `events.jsonl`, without command text.
An unusable reviewer response gets one clarification in the same session; if
still unusable, Conductor stops instead of starting repeated empty reviews.

## CLI

Run these commands from the extracted repository:

```powershell
node src/conductor.mjs provider ollama http://127.0.0.1:11434/v1
# Or: node src/conductor.mjs provider lmstudio http://127.0.0.1:1234/v1
# Or: node src/conductor.mjs provider custom https://provider.example/v1 MY_MODEL_API_KEY
node src/conductor.mjs models
node src/conductor.mjs init C:\Projects\MyProject C:\Projects\prompt.txt YOUR_MODEL_ID
node src/conductor.mjs run C:\Projects\MyProject
node src/conductor.mjs status C:\Projects\MyProject
node src/conductor.mjs stop C:\Projects\MyProject
node src/conductor.mjs set-provider C:\Projects\MyProject YOUR_MODEL_ID
node src/conductor.mjs reopen C:\Projects\MyProject BUILDER C:\Projects\feedback.txt
```

The CLI also starts the bundled proxy automatically. Set the API-key environment
variable before `models` or `run` if required. `run PROJECT --headless` omits the
native display window. After reopening, use `run` to start the selected phase.

## Development verification

`npm test` runs controller, handoff, retry, launcher, proxy-stream, and provider
translation tests. To exercise an installed Codex binary against a deterministic
local Responses test server:

```powershell
$env:CONDUCTOR_NATIVE_TEST = '1'
node --test test/native-provider.test.mjs
```

The smoke test uses a copied launcher and an isolated temporary Codex home.
It checks a real file edit and tool-result round trip without NOVA Desktop,
SSH, credentials, or model inference. This is not a model-quality benchmark
or a claim of live Ollama/LM Studio validation. Temporary smoke files remain in
TEMP for diagnosis. Test a small project with your actual provider/model first.
