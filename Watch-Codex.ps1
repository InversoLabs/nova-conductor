param([Parameter(Mandatory=$true)][string]$Project)
$ErrorActionPreference='Stop'
$env:TERM='xterm-256color'
$env:CODEX_HOME=Join-Path $env:LOCALAPPDATA 'NOVA-Codex'
Set-Location -LiteralPath (Join-Path $Project 'work')
$stateFile=Join-Path $Project 'viewer.json'
$last=''
$attachAttempts=@{}
Write-Host 'NOVA CONDUCTOR - waiting for a fresh Codex role session' -ForegroundColor Cyan
while ($true) {
    if (-not (Test-Path -LiteralPath $stateFile)) { Start-Sleep -Milliseconds 500; continue }
    $s=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
    if ($s.done) { Write-Host "Conductor: $($s.status)" -ForegroundColor Cyan; Read-Host 'Press Enter to close'; exit }
    if ($s.threadId -and $s.threadId -ne $last) {
        $last=$s.threadId
        if(-not $attachAttempts.ContainsKey($last)){$attachAttempts[$last]=0}
        $attachAttempts[$last]++
        & node (Join-Path $PSScriptRoot 'src/wait-viewer.mjs') $s.url $s.threadId
        if($LASTEXITCODE -ne 0){
            if($attachAttempts[$last] -lt 3){$last='';Start-Sleep -Seconds 2}
            else{Write-Host 'Could not attach after three attempts. The builder may still be running; reopen this viewer to retry.' -ForegroundColor Yellow}
            continue
        }
        $Host.UI.RawUI.WindowTitle="Nova Conductor - $($s.role)"
        Write-Host "`n$($s.role) | Fresh 16K session | Native Codex" -ForegroundColor Cyan
        # A helper ends only this viewer at the role boundary. The server and
        # model turn belong to Conductor, not this display process.
        $nativeCommand="& codex --remote $($s.url) resume $($s.threadId); exit `$LASTEXITCODE"
        $encoded=[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($nativeCommand))
        $viewer=Start-Process powershell.exe -ArgumentList @('-NoProfile','-EncodedCommand',$encoded) -NoNewWindow -PassThru
        $null=$viewer.Handle
        $changedRole=$false
        Add-Content -LiteralPath (Join-Path $Project 'viewer-events.log') -Value "Started native viewer PID $($viewer.Id) for $last"
        while (-not $viewer.HasExited) {
            Start-Sleep -Milliseconds 500
            $next=Get-Content -LiteralPath $stateFile -Raw | ConvertFrom-Json
            if ($next.threadId -ne $last -or $next.done) { $changedRole=$true; & taskkill /PID $viewer.Id /T /F 2>$null | Out-Null; break }
        }
        Add-Content -LiteralPath (Join-Path $Project 'viewer-events.log') -Value "Viewer ended for $last (exit $($viewer.ExitCode))"
        if(-not $changedRole -and $viewer.ExitCode -ne 0 -and $attachAttempts[$last] -lt 3){
            Write-Host 'Viewer attach failed; retrying without restarting the worker...' -ForegroundColor Yellow
            $last='';Start-Sleep -Seconds 2
        }
    }
    Start-Sleep -Milliseconds 500
}
