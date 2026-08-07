[CmdletBinding()]
param(
  [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$distributionDirectory = Join-Path $repositoryRoot 'apps\control-center\dist'

function Invoke-NpmStep {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Title,

    [Parameter(Mandatory = $true)]
    [string[]]$Arguments
  )

  Write-Host "`n== $Title ==" -ForegroundColor Cyan
  & npm @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Title failed (npm exit code: $LASTEXITCODE)."
  }
}

try {
  if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw 'npm was not found. Install Node.js LTS, then run this file again.'
  }

  Set-Location -LiteralPath $repositoryRoot
  $buildStartedAt = Get-Date

  Invoke-NpmStep -Title 'Syncing dependencies' -Arguments @('install', '--no-audit', '--no-fund')
  if (-not $SkipTests) {
    Invoke-NpmStep -Title 'Running tests' -Arguments @('test')
  }
  Invoke-NpmStep -Title 'Building Windows ZIP' -Arguments @('run', 'dist')

  $artifact = Get-ChildItem -LiteralPath $distributionDirectory -Filter 'Suzu-Lives-Console-*-win-x64.zip' -File |
    Where-Object { $_.LastWriteTime -ge $buildStartedAt.AddMinutes(-1) } |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

  if (-not $artifact) {
    throw "Build completed but no Windows ZIP was found in $distributionDirectory."
  }

  Write-Host "`nPackage ready:" -ForegroundColor Green
  Write-Host $artifact.FullName -ForegroundColor Green
  Start-Process explorer.exe -ArgumentList @("/select,`"$($artifact.FullName)`"")
  exit 0
} catch {
  Write-Host "`nPackaging failed:" -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
