# ═══════════════════════════════════════════════════════════════════
#  run-demo.ps1 — Run a Policy Translator migration package in order
# ═══════════════════════════════════════════════════════════════════
#
#  Runs every numbered script in a generated package folder in the correct
#  order, with a clear banner and a pause before each step. Built for live
#  demos: you can talk through each step, press Enter to run it, and watch
#  the result before moving on.
#
#  Usage (from inside the package folder):
#      pwsh ./run-demo.ps1
#
#  Or point it at a package folder:
#      pwsh ./run-demo.ps1 -PackagePath "C:\path\to\migration-package"
#
#  Flags:
#      -Auto     Run without pausing between steps (unattended).
#      -DryRun   Show the run order only; do not execute anything.
# ═══════════════════════════════════════════════════════════════════

param(
    [string] $PackagePath = $PSScriptRoot,
    [switch] $Auto,
    [switch] $DryRun
)

$ErrorActionPreference = "Stop"

function Write-Banner([string] $text, [string] $color = "Cyan") {
    Write-Host ""
    Write-Host ("=" * 64) -ForegroundColor $color
    Write-Host "  $text" -ForegroundColor $color
    Write-Host ("=" * 64) -ForegroundColor $color
}

if (-not (Test-Path $PackagePath)) {
    Write-Host "Package folder not found: $PackagePath" -ForegroundColor Red
    exit 1
}

# Collect numbered scripts (01-... .ps1), sorted by their leading number.
# This orchestrator excludes itself so it never re-runs run-demo.ps1.
$scripts = Get-ChildItem -Path $PackagePath -Filter "*.ps1" |
    Where-Object { $_.Name -match '^\d{2}[a-z]?-' } |
    Sort-Object Name

if ($scripts.Count -eq 0) {
    Write-Host "No numbered scripts found in: $PackagePath" -ForegroundColor Red
    Write-Host "Generate a package first, then run this from inside it." -ForegroundColor Yellow
    exit 1
}

Write-Banner "Policy Translator demo — $($scripts.Count) step(s)" "Magenta"
Write-Host "  Folder: $PackagePath" -ForegroundColor Gray
Write-Host "  Run order:" -ForegroundColor Gray
$i = 0
foreach ($s in $scripts) { $i++; Write-Host ("   {0}. {1}" -f $i, $s.Name) -ForegroundColor White }

if ($DryRun) {
    Write-Host "`n[DryRun] Nothing was executed." -ForegroundColor Yellow
    exit 0
}

$step = 0
foreach ($s in $scripts) {
    $step++
    Write-Banner "Step $step of $($scripts.Count):  $($s.Name)"

    if (-not $Auto) {
        Write-Host "  Press Enter to run this step (Ctrl+C to stop)..." -ForegroundColor Yellow
        [void](Read-Host)
    }

    & $s.FullName
    $code = $LASTEXITCODE

    if ($null -ne $code -and $code -ne 0) {
        Write-Host "`n  Step '$($s.Name)' exited with code $code. Stopping." -ForegroundColor Red
        Write-Host "  Fix the issue above, then re-run. Scripts are idempotent, so re-running is safe." -ForegroundColor Yellow
        exit $code
    }

    Write-Host "`n  Step $step done." -ForegroundColor Green
}

Write-Banner "All steps complete" "Green"
Write-Host "  Verify in the Entra admin center, then open gap-report.md for anything" -ForegroundColor White
Write-Host "  that still needs manual configuration." -ForegroundColor White
