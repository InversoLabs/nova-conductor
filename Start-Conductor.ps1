param([switch]$CheckOnly)
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'Model-Selector.ps1')
$cli=Join-Path $PSScriptRoot 'src/conductor.mjs'
$projects=Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Nova Conductor Projects'
$model='gpt-oss:20b'
function Read-Project {
    $candidates=@()
    if(Test-Path -LiteralPath $projects){$candidates+=@(Get-ChildItem -LiteralPath $projects -Directory | ForEach-Object {$_.FullName})}
    $extraFile=Join-Path $PSScriptRoot 'extra-projects.json'
    if(Test-Path -LiteralPath $extraFile){$candidates+=@(Get-Content -LiteralPath $extraFile -Raw | ConvertFrom-Json)}
    $choices=@(foreach($candidate in ($candidates | Select-Object -Unique)) {
        $stateFile=Join-Path $candidate 'state.json'
        if(Test-Path -LiteralPath $stateFile){
            try {
                $state=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
                if($state.config.contextTokens -ne 16384 -or -not $state.role){continue}
                [pscustomobject]@{Root=$candidate;Name=(Split-Path $candidate -Leaf);Status=$state.status;Role=$state.role;Updated=(Get-Item -LiteralPath $stateFile).LastWriteTime}
            }catch{Write-Warning "Cannot read project: $candidate"}
        }
    })
    $choices=@($choices | Sort-Object Updated -Descending)
    Write-Host "`nSelect a project" -ForegroundColor Cyan
    for($i=0;$i -lt $choices.Count;$i++){
        $item=$choices[$i]
        Write-Host ("{0}  {1}  [{2} / {3}]" -f ($i+1),$item.Name,$item.Status,$item.Role)
        Write-Host ("   "+$item.Root) -ForegroundColor DarkGray
    }
    if(-not $choices.Count){Write-Host 'No saved projects found yet.'}
    Write-Host 'P  Enter another folder  |  Q  Back'
    $selection=(Read-Host 'Project number').Trim()
    if($selection -eq 'Q'){return $null}
    $number=0
    if([int]::TryParse($selection,[ref]$number) -and $number -ge 1 -and $number -le $choices.Count){return $choices[$number-1].Root}
    if($selection -ne 'P'){throw 'Choose a project number, P, or Q.'}
    $root=(Read-Host 'Conductor project folder (contains state.json)').Trim().Trim('"')
    if(-not(Test-Path -LiteralPath (Join-Path $root 'state.json'))) {throw 'Not a Conductor project.'}
    return $root
}
function Start-Project {
    param([string]$Root)
    $state=Get-Content -LiteralPath (Join-Path $Root 'state.json') -Raw | ConvertFrom-Json
    $selectedProvider=& node $cli provider | ConvertFrom-Json
    if($LASTEXITCODE -ne 0){throw 'Cannot read global provider settings.'}
    $keyName=$selectedProvider.keyEnv
    $prior=$null
    if($keyName){$prior=[Environment]::GetEnvironmentVariable($keyName,'Process')}
    try {
        if($keyName -and -not $prior){
            $secure=Read-Host "API key for $keyName (used only for this run)" -AsSecureString
            $ptr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
            try {[Environment]::SetEnvironmentVariable($keyName,[Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr),'Process')}
            finally {[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)}
        }
        & node $cli run $Root
    } finally {if($keyName){[Environment]::SetEnvironmentVariable($keyName,$prior,'Process')};$prior=$null}
}
function Set-Provider {
    Write-Host '1 Ollama | 2 LM Studio | 3 Other Responses-compatible provider | 4 NOVA bridge'
    $kind=switch(Read-Host 'Provider'){'1'{'ollama'} '2'{'lmstudio'} '3'{'custom'} '4'{'nova'} default{throw 'Choose 1, 2, 3, or 4.'}}
    $saved=& node $cli provider-defaults $kind | ConvertFrom-Json
    if($LASTEXITCODE -ne 0){throw 'Cannot read provider defaults.'}
    $default=$saved.baseUrl
    $url=(Read-Host "API base URL including /v1 (Enter keeps $default)").Trim()
    if(-not $url){$url=$default}
    $keyName=(Read-Host "API key variable NAME (Enter keeps '$($saved.keyEnv)'; - means no authentication)").Trim()
    if(-not $keyName){$keyName=$saved.keyEnv}elseif($keyName -eq '-'){$keyName=''}
    & node $cli provider $kind $url $keyName
    if($LASTEXITCODE -ne 0){throw 'Invalid provider configuration.'}
}
foreach($name in @('node','git','codex')){if(-not(Get-Command $name -ErrorAction SilentlyContinue)){throw "$name is required on PATH. See README.md for setup."}}
if($CheckOnly){Write-Host 'Nova Conductor launcher ready.';exit 0}
while($true){
    Write-Host "`nNOVA CONDUCTOR" -ForegroundColor Cyan
    Write-Host 'Prompt > Planner > Builder > Reviewer > checklist > Builder'
    Write-Host 'Each role opens a fresh 16K session in the native Codex window.'
    $provider=(& node $cli provider | ConvertFrom-Json)
    Write-Host "Global provider: $($provider.kind) at $($provider.baseUrl)"
    Write-Host "1 New project  |  2 Continue  |  3 Status  |  4 Stop  |  5 Projects  |  6 Model ($model)  |  7 Reopen  |  8 Global provider settings  |  9 Global provider settings  |  I Import existing codebase  |  Q Quit"
    try {
        switch((Read-Host 'Choose').ToUpperInvariant()){
            '1' {
                $name=Read-Host 'Project name'
                if($name -notmatch '^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$'){throw 'Use letters, numbers, spaces or dashes.'}
                $prompt=Read-Host 'What should it build?'
                if(-not $prompt.Trim()){throw 'A prompt is required.'}
                $model=Select-Model -Current $model
                $root=Join-Path $projects ($name+'-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
                $temp=[IO.Path]::GetTempFileName()
                try {
                    [IO.File]::WriteAllText($temp,$prompt)
                    & node $cli init $root $temp $model
                    if($LASTEXITCODE -ne 0){throw 'Project initialization failed.'}
                } finally {Remove-Item -LiteralPath $temp}
                Write-Host 'The planner chooses checks for your project. Optional extra verification: command argv arrays as JSON.'
                $commands=Read-Host 'Extra verification commands (Enter skips extra gate)'
                if($commands){
                    $cfg=Get-Content (Join-Path $root 'state.json') -Raw | ConvertFrom-Json
                    $cfg.config.verification=(ConvertFrom-Json ('{"commands":'+$commands+'}')).commands
                    [IO.File]::WriteAllText((Join-Path $root 'state.json'),($cfg | ConvertTo-Json -Depth 10))
                }
                Write-Host "Project: $root" -ForegroundColor Green
                Start-Project $root
            }
            '2' {$selected=Read-Project;if($selected){Start-Project $selected}}
            '3' {$selected=Read-Project;if($selected){& node $cli status $selected}}
            '4' {$selected=Read-Project;if($selected){& node $cli stop $selected}}
            '5' {New-Item -ItemType Directory -Path $projects -Force | Out-Null; Start-Process explorer.exe -ArgumentList ('"'+$projects+'"')}
            '6' {$model=Select-Model -Current $model}
            '8' {Set-Provider}
            '9' {Set-Provider}
            '7' {
                $selected=Read-Project
                if($selected){
                    Write-Host 'Restart from: 1 Planner | 2 Builder | 3 Reviewer'
                    $phase=Read-Host 'Choose phase'
                    $role=switch($phase){'1'{'PLANNER'} '2'{'BUILDER'} '3'{'REVIEWER'} default{throw 'Choose 1, 2, or 3.'}}
                    $feedback=Read-Host 'Guidance for this phase (Enter to continue existing work)'
                    if(-not $feedback.Trim()){$feedback='Continue from the existing project files and current requirements.'}
                    if(-not $feedback.Trim()){throw 'Feedback is required.'}
                    $temp=[IO.Path]::GetTempFileName()
                    try {
                        [IO.File]::WriteAllText($temp,$feedback)
                        & node $cli reopen $selected $role $temp
                        if($LASTEXITCODE -ne 0){throw 'Could not reopen project.'}
                    } finally {Remove-Item -LiteralPath $temp}
                    Start-Project $selected
                }
            }
            'I' {
                $source=(Read-Host 'Existing codebase folder to import').Trim().Trim('"')
                if(-not(Test-Path -LiteralPath $source -PathType Container)){throw 'Choose an existing codebase folder.'}
                $name=Read-Host 'Name for the new Conductor project'
                if($name -notmatch '^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$'){throw 'Use letters, numbers, spaces or dashes.'}
                $prompt=Read-Host 'What should the builder change or complete?'
                if(-not $prompt.Trim()){throw 'Describe the requested work.'}
                $model=Select-Model -Current $model
                $root=Join-Path $projects ($name+'-'+[DateTime]::Now.ToString('yyyyMMdd-HHmmss'))
                Write-Host 'Importing a separate working copy; the original folder stays unchanged.' -ForegroundColor Cyan
                $temp=[IO.Path]::GetTempFileName()
                try {
                    [IO.File]::WriteAllText($temp,$prompt)
                    & node $cli import $root $source $temp $model
                    if($LASTEXITCODE -ne 0){throw 'Import failed; builder was not started.'}
                } finally {Remove-Item -LiteralPath $temp}
                Write-Host "Working copy: $root\work" -ForegroundColor Green
                Start-Project $root
            }
            'Q' {exit}
        }
    }catch{Write-Host $_.Exception.Message -ForegroundColor Red}
}
