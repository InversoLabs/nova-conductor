function Select-Model {
    param([string]$Current)
    $models = @()
    try {
        Write-Host 'Reading installed models from NOVA-SERVER...'
        $query = "`$ProgressPreference='SilentlyContinue'; (Invoke-RestMethod 'http://127.0.0.1:11434/api/tags' -TimeoutSec 10).models | Select-Object -ExpandProperty name | ConvertTo-Json -Compress"
        $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($query))
        $raw = & ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=10 -o ServerAliveCountMax=1 NOVA-SERVER "powershell.exe -NoProfile -EncodedCommand $encoded" 2>$null
        if ($LASTEXITCODE -eq 0 -and $raw) { $models = @((ConvertFrom-Json ($raw -join "`n")) | Sort-Object -Unique) }
    } catch { Write-Host 'Could not read the server model list; enter an exact model name below.' }
    for ($i = 0; $i -lt $models.Count; $i++) { Write-Host ("{0}  {1}" -f ($i + 1), $models[$i]) }
    $answer = (Read-Host "Select a number or enter an installed model name (Enter keeps $Current)").Trim()
    if (-not $answer) { return $Current }
    $number = 0
    if ([int]::TryParse($answer, [ref]$number)) {
        if ($number -lt 1 -or $number -gt $models.Count) { throw 'Invalid model number.' }
        return $models[$number - 1]
    }
    if ($answer -notmatch '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$') { throw 'Invalid model name.' }
    return $answer
}