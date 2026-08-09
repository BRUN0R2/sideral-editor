[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ProjectRoot,

    [ValidateRange(1, 65535)]
    [int]$Port = 1420
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\', '/')
$listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)

if ($listeners.Count -eq 0) {
    exit 0
}

$processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)
$ownedProcesses = [System.Collections.Generic.List[object]]::new()
$foreignProcesses = [System.Collections.Generic.List[object]]::new()

foreach ($processId in $processIds) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
    if ($null -eq $process) {
        continue
    }

    $commandLine = [string]$process.CommandLine
    $belongsToProject =
        $process.Name -ieq 'node.exe' -and
        $commandLine.IndexOf($resolvedRoot, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and
        $commandLine -match '(?i)[\\/]vite[\\/]bin[\\/]vite\.js'

    $processInfo = [PSCustomObject]@{
        Id = [int]$process.ProcessId
        Name = [string]$process.Name
        CommandLine = $commandLine
    }

    if ($belongsToProject) {
        $ownedProcesses.Add($processInfo)
    }
    else {
        $foreignProcesses.Add($processInfo)
    }
}

if ($foreignProcesses.Count -gt 0) {
    foreach ($process in $foreignProcesses) {
        Write-Host "A porta $Port esta em uso por outro processo: $($process.Name) (PID $($process.Id))."
    }
    Write-Host 'Feche esse processo ou altere a porta antes de iniciar o modo dev.'
    exit 2
}

foreach ($process in $ownedProcesses) {
    Write-Host "Encerrando um servidor Vite anterior do Sideral Editor (PID $($process.Id))..."
    Stop-Process -Id $process.Id -ErrorAction Stop
}

for ($attempt = 0; $attempt -lt 20; $attempt++) {
    if (-not (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
        exit 0
    }
    Start-Sleep -Milliseconds 100
}

Write-Host "Nao foi possivel liberar a porta $Port."
exit 3
