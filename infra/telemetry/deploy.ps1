[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ResourceGroup,

    [string]$Location = "westus2",

    [string]$BaseName = "policy-translator-telemetry"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$template = Join-Path $root "main.bicep"
$functionSource = Join-Path $root "function"
$package = Join-Path $env:TEMP "policy-translator-telemetry-function.zip"

function Assert-AzSucceeded {
    param([string]$Operation)
    if ($LASTEXITCODE -ne 0) {
        throw "Azure CLI failed while $Operation (exit code $LASTEXITCODE)."
    }
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw "Azure CLI is required. Install it, run 'az login', and retry."
}

$accountJson = az account show --output json 2>$null
Assert-AzSucceeded "reading the active account"
$account = $accountJson | ConvertFrom-Json
if (-not $account) {
    throw "Sign in first with 'az login'."
}

try {
    az group show --name $ResourceGroup --output none 2>$null
    if ($LASTEXITCODE -ne 0) {
        az group create --name $ResourceGroup --location $Location --output none
        Assert-AzSucceeded "creating resource group '$ResourceGroup'"
    }

    $deploymentJson = az deployment group create `
        --resource-group $ResourceGroup `
        --template-file $template `
        --parameters baseName=$BaseName location=$Location `
        --output json
    Assert-AzSucceeded "deploying telemetry infrastructure"
    $deployment = $deploymentJson | ConvertFrom-Json

    $functionAppName = $deployment.properties.outputs.functionAppName.value
    $endpoint = $deployment.properties.outputs.telemetryEndpoint.value
    $insightsName = $deployment.properties.outputs.applicationInsightsName.value
    $workbookId = $deployment.properties.outputs.workbookResourceId.value
    if (-not $functionAppName -or -not $endpoint -or -not $insightsName -or -not $workbookId) {
        throw "Azure deployment did not return all required outputs."
    }

    if (Test-Path $package) { Remove-Item -LiteralPath $package -Force }
    Compress-Archive -Path (Join-Path $functionSource "*") -DestinationPath $package -Force
    az functionapp deployment source config-zip `
        --resource-group $ResourceGroup `
        --name $functionAppName `
        --src $package `
        --output none
    Assert-AzSucceeded "publishing the telemetry Function"

    $functionKey = az functionapp keys list `
        --resource-group $ResourceGroup `
        --name $functionAppName `
        --query "functionKeys.default" `
        --output tsv
    Assert-AzSucceeded "reading the telemetry Function key"
    if (-not $functionKey) {
        throw "Azure did not return the telemetry Function key."
    }

    Write-Host ""
    Write-Host "Telemetry infrastructure deployed." -ForegroundColor Green
    Write-Host "Application Insights: $insightsName"
    Write-Host "Workbook resource:    $workbookId"
    Write-Host ""
    Write-Host "Configure an official Policy Translator launch with:" -ForegroundColor Cyan
    Write-Host "`$env:POLICY_TRANSLATOR_TELEMETRY_ENDPOINT = `"$endpoint`""
    Write-Host "`$env:POLICY_TRANSLATOR_TELEMETRY_KEY = `"$functionKey`""
    Write-Host "npm run web:proto"
    Write-Host ""
    Write-Host "Use POLICY_TRANSLATOR_TELEMETRY=off to disable telemetry for a launch."
} finally {
    if (Test-Path $package) { Remove-Item -LiteralPath $package -Force }
}
