# Start from an existing codebase

Restart the launcher and choose **I — Import existing codebase**. Enter the source folder, a name for the Conductor project, the changes you want, and a model. Conductor copies the files into a new project's `work` directory and immediately starts a fresh Builder session, followed by the normal Reviewer/repair loop.

The original folder is unchanged. Work on the copy; changes are not automatically synced back. The launcher prints its location, and the imported project appears under Continue and Reopen.

Existing AGENTS.md instructions are preserved. Existing root REQUEST.md, BUILD_PLAN.md, BUILD_NOTES.md, BUILD_CHECKLIST.md, and REVIEW.md are retained under `imported-documents` outside the worker workspace; new task documents describe the requested changes. Git metadata, node_modules, Python virtual environments, and caches are omitted. Other files, including project assets and configuration, are copied. Symbolic links/junctions are rejected rather than followed. Dependencies may need reinstalling if the requested checks require them.

CLI:

```powershell
node src/conductor.mjs import "C:\Projects\Conductor Copy" "C:\Projects\Existing App" "C:\Projects\changes.txt" gpt-oss:20b
node src/conductor.mjs run "C:\Projects\Conductor Copy"
```

The destination must be new and outside the source folder. Use Continue/Reopen for an existing Conductor project.
