[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateRange(1, [int]::MaxValue)]
    [int]$ProcessId,

    [ValidateRange(2, 10000)]
    [int]$SampleCount = 181,

    [ValidateRange(1, 3600)]
    [int]$IntervalSeconds = 10,

    [ValidateRange(0, [long]::MaxValue)]
    [long]$MaximumPrivateBytesGrowth = 67108864,

    [ValidateRange(0, [long]::MaxValue)]
    [long]$MaximumWorkingSetBytesGrowth = 100663296,

    [ValidateRange(0, [int]::MaxValue)]
    [int]$MaximumHandleGrowth = 64,

    [ValidateRange(0, [int]::MaxValue)]
    [int]$MaximumThreadGrowth = 4
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Get-OwnedProcessIds {
    param(
        [Parameter(Mandatory = $true)]
        [int]$RootProcessId
    )

    $processRows = Get-CimInstance -ClassName Win32_Process |
        Select-Object ProcessId, ParentProcessId
    $ownedIds = [System.Collections.Generic.HashSet[uint32]]::new()
    [void]$ownedIds.Add([uint32]$RootProcessId)

    do {
        $added = $false
        foreach ($processRow in $processRows) {
            if ($ownedIds.Contains([uint32]$processRow.ParentProcessId)) {
                $added = $ownedIds.Add([uint32]$processRow.ProcessId) -or $added
            }
        }
    } while ($added)

    return $ownedIds
}

function Get-ResourceSnapshot {
    param(
        [Parameter(Mandatory = $true)]
        [int]$RootProcessId
    )

    [void](Get-Process -Id $RootProcessId -ErrorAction Stop)
    $ownedProcesses = foreach ($ownedProcessId in Get-OwnedProcessIds -RootProcessId $RootProcessId) {
        Get-Process -Id $ownedProcessId -ErrorAction SilentlyContinue
    }

    return [pscustomobject]@{
        Timestamp = [DateTimeOffset]::Now
        ProcessCount = @($ownedProcesses).Count
        PrivateBytes = [long](($ownedProcesses | Measure-Object -Property PrivateMemorySize64 -Sum).Sum)
        WorkingSetBytes = [long](($ownedProcesses | Measure-Object -Property WorkingSet64 -Sum).Sum)
        Handles = [int](($ownedProcesses | Measure-Object -Property HandleCount -Sum).Sum)
        Threads = [int](($ownedProcesses | ForEach-Object { $_.Threads.Count } | Measure-Object -Sum).Sum)
    }
}

function Format-Mebibytes {
    param(
        [Parameter(Mandatory = $true)]
        [long]$Bytes
    )

    return "{0:N1} MiB" -f ($Bytes / 1MB)
}

$samples = [System.Collections.Generic.List[object]]::new($SampleCount)
for ($sampleIndex = 0; $sampleIndex -lt $SampleCount; $sampleIndex += 1) {
    $snapshot = Get-ResourceSnapshot -RootProcessId $ProcessId
    $samples.Add($snapshot)
    Write-Host (
        "[{0}/{1}] processes={2} private={3} workingSet={4} handles={5} threads={6}" -f
        ($sampleIndex + 1),
        $SampleCount,
        $snapshot.ProcessCount,
        (Format-Mebibytes -Bytes $snapshot.PrivateBytes),
        (Format-Mebibytes -Bytes $snapshot.WorkingSetBytes),
        $snapshot.Handles,
        $snapshot.Threads
    )

    if ($sampleIndex + 1 -lt $SampleCount) {
        Start-Sleep -Seconds $IntervalSeconds
    }
}

$first = $samples[0]
$last = $samples[$samples.Count - 1]
$privateBytesGrowth = $last.PrivateBytes - $first.PrivateBytes
$workingSetGrowth = $last.WorkingSetBytes - $first.WorkingSetBytes
$handleGrowth = $last.Handles - $first.Handles
$threadGrowth = $last.Threads - $first.Threads

Write-Host (
    "Growth: private={0}, workingSet={1}, handles={2}, threads={3}" -f
    (Format-Mebibytes -Bytes $privateBytesGrowth),
    (Format-Mebibytes -Bytes $workingSetGrowth),
    $handleGrowth,
    $threadGrowth
)

$violations = [System.Collections.Generic.List[string]]::new()
if ($privateBytesGrowth -gt $MaximumPrivateBytesGrowth) {
    $violations.Add("private-byte growth exceeded $(Format-Mebibytes -Bytes $MaximumPrivateBytesGrowth)")
}
if ($workingSetGrowth -gt $MaximumWorkingSetBytesGrowth) {
    $violations.Add("working-set growth exceeded $(Format-Mebibytes -Bytes $MaximumWorkingSetBytesGrowth)")
}
if ($handleGrowth -gt $MaximumHandleGrowth) {
    $violations.Add("handle growth exceeded $MaximumHandleGrowth")
}
if ($threadGrowth -gt $MaximumThreadGrowth) {
    $violations.Add("thread growth exceeded $MaximumThreadGrowth")
}

if ($violations.Count -gt 0) {
    throw "Long-session resource budgets failed: $($violations -join '; ')."
}

Write-Host "Long-session resource budgets passed."
