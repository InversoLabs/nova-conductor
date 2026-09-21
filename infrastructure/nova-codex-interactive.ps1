param(
    [Parameter(Mandatory = $true)]
    [string]$Model,
    [string]$Workspace = (Get-Location).Path,
    [ValidateSet('https://nova.inversolabs.us', 'http://192.168.86.51:8787', 'http://127.0.0.1:8788')]
    [string]$BaseUrl = 'https://nova.inversolabs.us',
    [ValidateSet('read-only', 'workspace-write')]
    [string]$Sandbox = 'workspace-write',
    [ValidateSet('minimal', 'low', 'medium', 'high')]
    [string]$Reasoning = 'minimal',
    [ValidateSet(4096, 8192, 12288, 16384)]
    [int]$ContextTokens = 8192,
    [string]$ModelCatalog,
    # Director-only batch mode. Omit both to retain the original manual TUI.
    [string]$PromptFile,
    [string]$ResultFile,
    [string]$InitialPromptFile,
    [switch]$ResumeSession,
    [int]$AppServerPort = 0
)

$AutoCompactTokens = switch ($ContextTokens) {
    4096 { 3000 }
    12288 { 9000 }
    16384 { 12000 }
    default { 6000 }
}

if ([string]::IsNullOrWhiteSpace($env:NOVA_DESKTOP_API_KEY)) {
    throw 'Set NOVA_DESKTOP_API_KEY privately before using NOVA with Codex.'
}
if (-not (Test-Path -LiteralPath $Workspace -PathType Container)) {
    throw 'The requested workspace folder does not exist.'
}
if (-not (Get-Command codex -ErrorAction SilentlyContinue)) {
    throw 'Codex CLI is not on PATH.'
}

# The launcher creates a real Windows console, but inherited environments can
# still label it as a non-interactive terminal and make Codex show a false TUI warning.
if ($env:TERM -eq 'dumb') { $env:TERM = 'xterm-256color' }

# Keep this lightweight local-model harness separate from the desktop Codex
# installation, whose plugins and skills would consume most of an 8K context.
$env:CODEX_HOME = Join-Path $env:LOCALAPPDATA 'NOVA-Codex'
New-Item -ItemType Directory -Path $env:CODEX_HOME -Force | Out-Null

# Ollama is tuned for one active request. Hold a machine-local mutex for the
# lifetime of Codex so a second launcher cannot compete for the same model.
$sessionMutex = [Threading.Mutex]::new($false, 'Local\NOVA.Codex.Remote.Session')
$ownsSession = $false
try {
    try {
        $ownsSession = $sessionMutex.WaitOne(0)
    } catch [Threading.AbandonedMutexException] {
    $ownsSession = $true
    }
    if (-not $ownsSession) {
        throw 'A NOVA Codex session is already running. Close it before starting another.'
    }

$directorRole = ''
$reviewScratch = ''
$reviewProfileFile = ''
if ($AppServerPort -and ($AppServerPort -lt 1024 -or $AppServerPort -gt 65535)) { throw 'Invalid app-server port.' }
if ($PromptFile) {
    $directorPrompt = Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8
    if ($directorPrompt -match "Nova Director's (PLANNER|BUILDER|REVIEWER|FINAL_REVIEWER|REPORTER),") {
        $directorRole = $Matches[1]
    }
    if ($directorRole -in @('REVIEWER', 'FINAL_REVIEWER')) {
        $reviewScratch = Join-Path ([IO.Path]::GetTempPath()) ('nova-director-review-' + [guid]::NewGuid().ToString('N'))
        New-Item -ItemType Directory -Path $reviewScratch -Force | Out-Null
        [IO.File]::WriteAllText((Join-Path (Split-Path $ResultFile) 'review-scratch.txt'), $reviewScratch)
    }
}

# Codex model metadata is keyed by the exact model slug. Build a small,
# process-local catalog for every selected Ollama model so pulled models receive
# the same shell and apply_patch tool contract instead of fallback metadata.
if ([string]::IsNullOrWhiteSpace($ModelCatalog)) {
    $catalogTemplate = Join-Path $PSScriptRoot 'nova-codex-models.json'
    if (Test-Path -LiteralPath $catalogTemplate -PathType Leaf) {
        $catalogObject = Get-Content -LiteralPath $catalogTemplate -Raw | ConvertFrom-Json
        if ($null -ne $catalogObject.models -and $catalogObject.models.Count -gt 0) {
            $catalogObject.models[0].slug = $Model
            $catalogObject.models[0].display_name = "$Model via NOVA"
            $catalogObject.models[0].description = "Local $Model coding inference through the authenticated NOVA Responses bridge."
            $catalogObject.models[0].context_window = $ContextTokens
            $catalogObject.models[0].max_context_window = $ContextTokens
            $manualCodingInstructions = $catalogObject.models[0].base_instructions
            if ($directorRole) {
                # The manual coding profile tells agents to implement. A Director
                # planner or reviewer has a different responsibility; avoid giving
                # the small model contradictory system and task instructions.
                $catalogObject.models[0].base_instructions = "You are Nova Director's $directorRole worker on Windows PowerShell. Follow the exact role and JSON final-result contract in the task. PLANNER only inspects relevant source and returns a small dependency-aware plan; never implement. BUILDER implements only its assigned task and verifies it. REVIEWER and FINAL_REVIEWER independently inspect and test, then return PASS or concrete REVISE; never patch or repair project files. Use provided Codex tools with direct PowerShell syntax, bounded output and targeted reads. Never recursively list .nova-director or read historical transcripts. Keep reasoning brief and act on the next relevant operation. Never request elevated permissions. Never change Git history or Director state. Return only the requested JSON as the final message."
                if ($reviewScratch) {
                    if ($directorRole -eq 'REVIEWER') {
                        $catalogObject.models[0].base_instructions += " Judge only CURRENT TASK and its acceptance criteria. Use the architecture and task map to distinguish later tasks. Do not reject this task merely because a future task's CLI, documentation or tests are not implemented yet. Final integration review checks the complete product."
                    }
                    $catalogObject.models[0].base_instructions += " Project files are read-only. Your writable test scratch directory is $reviewScratch (also TEMP/TMP/TMPDIR). Write test fixtures and temporary scripts only there, import project modules by absolute path, and run existing tests. A denied project write is a sandbox restriction, not a product defect. Do not claim tests passed unless you observed them pass."
                }
                if ($directorRole -eq 'BUILDER') {
                    $catalogObject.models[0].base_instructions = $manualCodingInstructions + " You are Nova Director's BUILDER. Implement only CURRENT TASK, verify it, and return the exact requested JSON final message. Use the latest review as corrections within that task's scope."
                }
                $catalogObject.models[0].base_instructions += " For exec_command use cmd, workdir, max_output_tokens and yield_time_ms as needed. Omit justification and sandbox_permissions; this unattended workflow never requests escalation. Use actual provided tool names, never invent a tool."
                if ($directorRole -eq 'REPORTER') {
                    $catalogObject.models[0].base_instructions = 'Format the supplied completion as the requested JSON. Do not use tools, inspect source, repeat work, or invent evidence.'
                }
                if ($directorRole -eq 'PLANNER') {
                    $catalogObject.models[0].base_instructions += " Include focused executable validation in each implementation task; do not defer all tests to the last task."
                }
            }
            if ($catalogObject.models[0].shell_type -ne 'unified_exec' -or
                $catalogObject.models[0].apply_patch_tool_type -ne 'freeform' -or
                [string]::IsNullOrWhiteSpace($catalogObject.models[0].base_instructions)) {
                throw 'The shared NOVA coding profile is incomplete.'
            }
            $catalogDirectory = Join-Path ([IO.Path]::GetTempPath()) 'nova-codex-models'
            New-Item -ItemType Directory -Path $catalogDirectory -Force | Out-Null
            $safeModel = $Model -replace '[^A-Za-z0-9_.-]', '-'
            $ModelCatalog = Join-Path $catalogDirectory "$safeModel.json"
            $catalogJson = $catalogObject | ConvertTo-Json -Depth 20
            [IO.File]::WriteAllText($ModelCatalog, $catalogJson, [Text.UTF8Encoding]::new($false))
        }
    }
}

# On the LAN, finish the slow cold load before Codex opens its shorter-lived
# inference stream. This prevents NOVA's request timeout from aborting Ollama
# during model warm-up. A resident model returns immediately.
if ($BaseUrl -in @('http://192.168.86.51:8787', 'http://127.0.0.1:8788')) {
    if (-not (Get-Command ssh -ErrorAction SilentlyContinue)) {
        throw 'Windows OpenSSH is required to warm the NOVA model.'
    }
    Write-Host "Loading $Model on NOVA-SERVER. A cold start can take several minutes..." -ForegroundColor Cyan
    $modelBytes = [Text.Encoding]::UTF8.GetBytes($Model)
    $modelBase64 = [Convert]::ToBase64String($modelBytes)
    $warmScript = @"
`$ErrorActionPreference='Stop'
`$model=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$modelBase64'))
`$contextTokens=$ContextTokens
`$running=@((Invoke-RestMethod 'http://127.0.0.1:11434/api/ps' -TimeoutSec 10).models)
`$current=`$running | Where-Object { `$_.name -eq `$model } | Select-Object -First 1
if(`$null -ne `$current -and [int64]`$current.context_length -ne `$contextTokens){
  `$unload=@{model=`$model;keep_alive=0} | ConvertTo-Json -Compress
  `$null=Invoke-RestMethod 'http://127.0.0.1:11434/api/generate' -Method Post -ContentType 'application/json' -Body `$unload -TimeoutSec 60
  `$current=`$null
}
if(`$null -eq `$current){
  `$body=@{model=`$model;prompt='Reply READY.';stream=`$false;keep_alive=-1;options=@{num_ctx=`$contextTokens;num_predict=1}} | ConvertTo-Json -Depth 5
  `$null=Invoke-RestMethod 'http://127.0.0.1:11434/api/generate' -Method Post -ContentType 'application/json' -Body `$body -TimeoutSec 900
}
[pscustomobject]@{ready=`$true;model=`$model;context=`$contextTokens} | ConvertTo-Json -Compress
"@
    $warmEncoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($warmScript))
    if ($PromptFile) {
        $warmResult = & ssh -o BatchMode=yes -o ConnectTimeout=15 -o ServerAliveInterval=15 -o ServerAliveCountMax=2 NOVA-SERVER "powershell.exe -NoProfile -EncodedCommand $warmEncoded"
    } else {
        $warmResult = & ssh NOVA-SERVER "powershell.exe -NoProfile -EncodedCommand $warmEncoded"
    }
    if ($LASTEXITCODE -ne 0 -or ($warmResult -join "`n") -notmatch '"ready":true') {
        throw "NOVA could not finish loading $Model. Check the Ollama tab in Control Station."
    }
    Write-Host "$Model is loaded. Starting Codex..." -ForegroundColor Green
}

# Interactive Codex has no --ignore-user-config flag in CLI v0.150.0.
# Override the local extensions for this process only; do not edit config.toml.
# NOVA/Ollama inference accepts function tools, not hosted or namespace tools.
$codexArgs = @(
    '-s', $Sandbox, '-a', 'never', '-C', (Resolve-Path -LiteralPath $Workspace).Path,
    '-m', $Model,
    '-c', ('model_reasoning_effort="' + $Reasoning + '"'),
    '-c', ('model_context_window=' + $ContextTokens),
    '-c', ('model_auto_compact_token_limit=' + $AutoCompactTokens),
    '-c', 'model_auto_compact_token_limit_scope="total"',
    '-c', 'tool_output_token_limit=2000',
    '-c', 'model_provider="nova_remote"',
    '-c', 'model_providers.nova_remote.name="NOVA Remote"',
    '-c', ('model_providers.nova_remote.base_url="' + $BaseUrl + '/v1"'),
    '-c', 'model_providers.nova_remote.env_key="NOVA_DESKTOP_API_KEY"',
    '-c', 'model_providers.nova_remote.request_max_retries=8',
    '-c', 'model_providers.nova_remote.stream_max_retries=3',
    # NOVA caps generation at 30 minutes. Codex needs a slightly longer SSE
    # idle window because local models may produce no model event until done.
    '-c', 'model_providers.nova_remote.stream_idle_timeout_ms=1860000',
    '-c', 'features.plugins=false',
    '-c', 'features.apps=false',
    '-c', 'features.remote_plugin=false',
    '-c', 'features.multi_agent=false',
    '-c', 'features.skill_search=false',
    '-c', 'features.code_mode.enabled=false',
    '-c', 'web_search="disabled"'
)
if (-not [string]::IsNullOrWhiteSpace($ModelCatalog)) {
    if (-not (Test-Path -LiteralPath $ModelCatalog -PathType Leaf)) {
        throw "Codex model catalog not found: $ModelCatalog"
    }
    $catalogPath = (Resolve-Path -LiteralPath $ModelCatalog).Path
    # ConvertTo-Json produces a safely quoted TOML-compatible string while
    # preserving the backslashes in a Windows path.
    $catalogValue = ConvertTo-Json -InputObject $catalogPath -Compress
    $codexArgs += @('-c', "model_catalog_json=$catalogValue")
}
if ($AppServerPort) {
    $serverArgs = @('app-server', '--listen', "ws://127.0.0.1:$AppServerPort")
    for ($i = 0; $i -lt $codexArgs.Count; $i++) {
        if ($codexArgs[$i] -ceq '-c') { $serverArgs += @('-c', $codexArgs[++$i]); continue }
        if ($codexArgs[$i] -cin @('-s','-a','-C','-m')) { $i++; continue }
    }
    $serverArgs += @('-c', ('model="' + $Model + '"'), '-c', 'approval_policy="never"')
    & codex @serverArgs
} elseif ($PromptFile) {
    if (-not $ResultFile) { throw 'ResultFile is required with PromptFile.' }
    # exec does not accept the global -a option here; use its config equivalent.
    # Keep the isolated NOVA home config: it contains the already-provisioned
    # Windows sandbox setting used by the working manual launcher.
    $batchArgs = @('exec', '--json', '--output-last-message', $ResultFile)
    for ($i = 0; $i -lt $codexArgs.Count; $i++) {
        if ($codexArgs[$i] -eq '-a') { $i++; continue }
        if ($reviewScratch -and $codexArgs[$i] -eq '-s') { $i++; continue }
        $batchArgs += $codexArgs[$i]
    }
    if ($reviewScratch) {
        # Read-only source plus one explicit writable scratch root. Do not grant
        # workspace-write simply to let a reviewer create test fixtures.
        $reviewProfileName = 'nova-director-review-' + [guid]::NewGuid().ToString('N')
        $reviewProfileFile = Join-Path $env:CODEX_HOME ($reviewProfileName + '.config.toml')
        $scratchLiteral = ConvertTo-Json -InputObject $reviewScratch -Compress
        # Windows PowerShell 5 strips embedded quotes in native argv. Put the
        # structured policy in a temporary profile, not an inline -c table.
        $reviewPolicy = @"
default_permissions = "nova_director_review"
[permissions.nova_director_review]
extends = ":read-only"
[permissions.nova_director_review.filesystem]
$scratchLiteral = "write"
"@
        [IO.File]::WriteAllText($reviewProfileFile, $reviewPolicy, [Text.UTF8Encoding]::new($false))
        $batchArgs += @('-p', $reviewProfileName)
        $env:TEMP = $reviewScratch
        $env:TMP = $reviewScratch
        $env:TMPDIR = $reviewScratch
        Write-Host "Reviewer test scratch: $reviewScratch"
    }
    $batchArgs += @('-c', 'approval_policy="never"', '-')
    $env:PYTHONIOENCODING = 'utf-8'
    $OutputEncoding = [Text.UTF8Encoding]::new($false)
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
    Get-Content -LiteralPath $PromptFile -Raw -Encoding UTF8 | & codex @batchArgs
} else {
    if ($ResumeSession) { $codexArgs = @('resume') + $codexArgs }
    elseif ($InitialPromptFile) { $codexArgs += @('--', [IO.File]::ReadAllText($InitialPromptFile)) }
    & codex @codexArgs
}
if ($LASTEXITCODE -ne 0) {
    throw "Codex exited with code $LASTEXITCODE."
}
} finally {
    if ($reviewProfileFile -and (Test-Path -LiteralPath $reviewProfileFile)) { Remove-Item -LiteralPath $reviewProfileFile }
    if ($ownsSession) { $sessionMutex.ReleaseMutex() }
    $sessionMutex.Dispose()
}
