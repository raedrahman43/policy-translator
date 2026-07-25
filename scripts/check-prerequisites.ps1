param(
    [switch] $GeneratedScripts
)

$ErrorActionPreference = "Stop"
$failures = @()
$warnings = @()

function Require-Command([string] $Name) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) {
        $script:failures += "Missing required command: $Name"
    }
    return $command
}

$node = Require-Command "node"
$npm = Require-Command "npm"

if ($node) {
    $nodeVersionText = (& node --version).Trim().TrimStart("v")
    $nodeVersion = [version]$nodeVersionText
    if ($nodeVersion.Major -lt 22) {
        $failures += "Node.js 22 or later is required (found $nodeVersionText)."
    } else {
        Write-Host "Node.js: $nodeVersionText" -ForegroundColor Green
    }
}

if ($npm) {
    Write-Host "npm: $((& npm --version).Trim())" -ForegroundColor Green
}

if ($PSVersionTable.PSVersion.Major -lt 7) {
    $failures += "PowerShell 7 or later is required (found $($PSVersionTable.PSVersion))."
} else {
    Write-Host "PowerShell: $($PSVersionTable.PSVersion)" -ForegroundColor Green
}

if ($GeneratedScripts) {
    $graphModule = Get-Module Microsoft.Graph.Authentication -ListAvailable |
        Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $graphModule) {
        $failures += "Microsoft.Graph PowerShell SDK is required to run generated scripts. Install-Module Microsoft.Graph -Scope CurrentUser"
    } else {
        Write-Host "Microsoft.Graph.Authentication: $($graphModule.Version)" -ForegroundColor Green
    }
}

if (-not (Test-Path (Join-Path $PSScriptRoot "..\package.json"))) {
    $warnings += "Run this command from the Policy Translator repository."
}

foreach ($warning in $warnings) {
    Write-Warning $warning
}

if ($failures.Count -gt 0) {
    foreach ($failure in $failures) {
        Write-Host "FAILED: $failure" -ForegroundColor Red
    }
    exit 1
}

Write-Host "Prerequisite check passed." -ForegroundColor Green
