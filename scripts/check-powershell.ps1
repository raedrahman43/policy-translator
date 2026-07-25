$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$templates = Get-ChildItem (Join-Path $root "src/generators/templates/*.ps1")
$failures = @()

foreach ($template in $templates) {
    $tokens = $null
    $errors = $null
    [System.Management.Automation.Language.Parser]::ParseFile(
        $template.FullName,
        [ref]$tokens,
        [ref]$errors
    ) | Out-Null

    foreach ($parseError in @($errors)) {
        $failures += "$($template.Name):$($parseError.Extent.StartLineNumber): $($parseError.Message)"
    }
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Error $_ }
    exit 1
}

Write-Host "PowerShell templates parsed successfully: $($templates.Count)"
