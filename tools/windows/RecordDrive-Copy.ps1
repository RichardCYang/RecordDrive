[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateNotNullOrEmpty()]
    [string]$Source,

    [Parameter(Mandatory = $true, Position = 1)]
    [ValidateNotNullOrEmpty()]
    [string]$Destination,

    [switch]$Move
)

$ErrorActionPreference = 'Stop'

function Get-RelativeRecordDrivePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$FullPath
    )

    $normalizedBase = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\') + '\'
    $normalizedFull = [System.IO.Path]::GetFullPath($FullPath)
    if (-not $normalizedFull.StartsWith($normalizedBase, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path '$normalizedFull' is outside '$normalizedBase'."
    }
    return $normalizedFull.Substring($normalizedBase.Length)
}

function New-TimestampRecord {
    param(
        [Parameter(Mandatory = $true)][System.IO.FileSystemInfo]$Item,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    [pscustomobject]@{
        RelativePath       = $RelativePath
        IsDirectory        = [bool]$Item.PSIsContainer
        CreationFileTime   = $Item.CreationTimeUtc.ToFileTimeUtc()
        LastWriteFileTime  = $Item.LastWriteTimeUtc.ToFileTimeUtc()
        LastAccessFileTime = $Item.LastAccessTimeUtc.ToFileTimeUtc()
    }
}

function Set-ExactRecordDriveTimes {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Metadata
    )

    $creation = [System.DateTime]::FromFileTimeUtc([long]$Metadata.CreationFileTime)
    $lastWrite = [System.DateTime]::FromFileTimeUtc([long]$Metadata.LastWriteFileTime)
    $lastAccess = [System.DateTime]::FromFileTimeUtc([long]$Metadata.LastAccessFileTime)

    if ($Metadata.IsDirectory) {
        [System.IO.Directory]::SetCreationTimeUtc($Path, $creation)
        [System.IO.Directory]::SetLastWriteTimeUtc($Path, $lastWrite)
        [System.IO.Directory]::SetLastAccessTimeUtc($Path, $lastAccess)
        $actualCreation = [System.IO.Directory]::GetCreationTimeUtc($Path).ToFileTimeUtc()
        $actualLastWrite = [System.IO.Directory]::GetLastWriteTimeUtc($Path).ToFileTimeUtc()
        $actualLastAccess = [System.IO.Directory]::GetLastAccessTimeUtc($Path).ToFileTimeUtc()
    }
    else {
        [System.IO.File]::SetCreationTimeUtc($Path, $creation)
        [System.IO.File]::SetLastWriteTimeUtc($Path, $lastWrite)
        [System.IO.File]::SetLastAccessTimeUtc($Path, $lastAccess)
        $actualCreation = [System.IO.File]::GetCreationTimeUtc($Path).ToFileTimeUtc()
        $actualLastWrite = [System.IO.File]::GetLastWriteTimeUtc($Path).ToFileTimeUtc()
        $actualLastAccess = [System.IO.File]::GetLastAccessTimeUtc($Path).ToFileTimeUtc()
    }

    if ($actualCreation -ne [long]$Metadata.CreationFileTime -or
        $actualLastWrite -ne [long]$Metadata.LastWriteFileTime -or
        $actualLastAccess -ne [long]$Metadata.LastAccessFileTime) {
        throw "Timestamp verification failed for '$Path'."
    }
}

$resolvedSource = (Resolve-Path -LiteralPath $Source).Path
$sourceItem = Get-Item -LiteralPath $resolvedSource -Force

if (-not (Test-Path -LiteralPath $Destination)) {
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
}
$resolvedDestination = (Resolve-Path -LiteralPath $Destination).Path
$metadata = New-Object System.Collections.Generic.List[object]

if ($sourceItem.PSIsContainer) {
    $metadata.Add((New-TimestampRecord -Item $sourceItem -RelativePath ''))
    foreach ($item in Get-ChildItem -LiteralPath $resolvedSource -Recurse -Force) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Reparse points are not supported: '$($item.FullName)'."
        }
        $relativePath = Get-RelativeRecordDrivePath -BasePath $resolvedSource -FullPath $item.FullName
        $metadata.Add((New-TimestampRecord -Item $item -RelativePath $relativePath))
    }
}
else {
    if (($sourceItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "Reparse points are not supported: '$resolvedSource'."
    }
    $metadata.Add((New-TimestampRecord -Item $sourceItem -RelativePath $sourceItem.Name))
}

$common = @(
    '/COPY:DAT',
    '/DCOPY:DAT',
    '/TIMFIX',
    '/R:2',
    '/W:1',
    '/Z',
    '/XJ',
    '/NP'
)

if ($sourceItem.PSIsContainer) {
    $arguments = @($resolvedSource, $resolvedDestination, '/E') + $common
    if ($Move) { $arguments += '/MOVE' }
}
else {
    $sourceDirectory = Split-Path -LiteralPath $resolvedSource -Parent
    $sourceName = Split-Path -LiteralPath $resolvedSource -Leaf
    $arguments = @($sourceDirectory, $resolvedDestination, $sourceName) + $common
    if ($Move) { $arguments += '/MOV' }
}

& robocopy.exe @arguments
$robocopyExitCode = $LASTEXITCODE
if ($robocopyExitCode -ge 8) {
    throw "Robocopy failed with exit code $robocopyExitCode."
}

# Apply files first, then directories deepest-first. Setting child metadata can
# alter parent directory times, so the destination root is always restored last.
$orderedMetadata = $metadata | Sort-Object `
    @{ Expression = { if ($_.IsDirectory) { 1 } else { 0 } }; Ascending = $true }, `
    @{ Expression = { $_.RelativePath.Length }; Descending = $true }

foreach ($record in $orderedMetadata) {
    $targetPath = if ([string]::IsNullOrEmpty($record.RelativePath)) {
        $resolvedDestination
    }
    else {
        Join-Path -Path $resolvedDestination -ChildPath $record.RelativePath
    }
    if (-not (Test-Path -LiteralPath $targetPath)) {
        throw "Copied destination item is missing: '$targetPath'."
    }
    Set-ExactRecordDriveTimes -Path $targetPath -Metadata $record
}

Write-Host "RecordDrive transfer completed with exact timestamp verification. Robocopy exit code: $robocopyExitCode"
exit 0
