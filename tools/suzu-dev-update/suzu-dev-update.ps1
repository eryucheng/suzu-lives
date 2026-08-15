[CmdletBinding()]
param(
  [switch]$DownloadOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Repository = "eryucheng/suzu-lives-private"
$Workflow = "package-windows.yml"
$Branch = "test"
$ArtifactName = "suzu-lives-dev-installer"
$InstallerPattern = "Suzu-Lives-Console-*-win-x64.exe"

function Invoke-GitHubCli {
  param(
    [Parameter(Mandatory)]
    [string[]]$CliArguments,
    [Parameter(Mandatory)]
    [string]$FailureMessage,
    [int]$MaxAttempts = 1
  )

  for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
    $rawOutput = & gh @CliArguments 2>&1
    $output = ($rawOutput | Out-String).Trim()
    if ($LASTEXITCODE -eq 0) {
      return $output
    }
    if ($attempt -lt $MaxAttempts) {
      Write-Host "下载暂时失败，正在重试（$attempt/$MaxAttempts）..."
      Start-Sleep -Seconds 2
      continue
    }
    if ($output) {
      throw "$FailureMessage`n$output"
    }
    throw $FailureMessage
  }
}

function Remove-UpdateTemporaryDirectory {
  param(
    [Parameter(Mandatory)]
    [string]$Path
  )

  $temporaryRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
  $candidate = [System.IO.Path]::GetFullPath($Path)
  $directoryName = [System.IO.Path]::GetFileName($candidate.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar))
  if (-not $candidate.StartsWith($temporaryRoot, [System.StringComparison]::OrdinalIgnoreCase) -or -not $directoryName.StartsWith("suzu-dev-update-", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝清理未验证的临时目录：$candidate"
  }
  if (Test-Path -LiteralPath $candidate -PathType Container) {
    Remove-Item -LiteralPath $candidate -Recurse -Force
  }
}

$temporaryDirectory = $null
$keepDownload = $false

try {
  if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    throw "未找到 GitHub CLI（gh）。请先安装 GitHub CLI，并运行 gh auth login 登录你的 GitHub 账号。"
  }

  Invoke-GitHubCli -CliArguments @("auth", "status", "--hostname", "github.com") -FailureMessage "GitHub CLI 尚未登录。请先运行 gh auth login 登录有私有仓库访问权的 GitHub 账号。" | Out-Null

  $runsJson = Invoke-GitHubCli -CliArguments @(
    "run", "list",
    "--repo", $Repository,
    "--workflow", $Workflow,
    "--branch", $Branch,
    "--status", "success",
    "--limit", "1",
    "--json", "databaseId,headSha,createdAt"
  ) -FailureMessage "无法查询私有测试构建。"
  $runs = @($runsJson | ConvertFrom-Json)
  if ($runs.Count -ne 1 -or -not $runs[0].databaseId) {
    throw "还没有成功的测试安装包。请先把代码推送到私有仓库的 test 分支，等待 GitHub Actions 完成。"
  }

  $run = $runs[0]
  $temporaryDirectory = Join-Path ([System.IO.Path]::GetTempPath()) ("suzu-dev-update-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

  $shortSha = ([string]$run.headSha).Substring(0, [Math]::Min(7, ([string]$run.headSha).Length))
  Write-Host "正在下载 test 分支的最新成功安装包（$shortSha）..."
  Invoke-GitHubCli -CliArguments @(
    "run", "download", [string]$run.databaseId,
    "--repo", $Repository,
    "--name", $ArtifactName,
    "--dir", $temporaryDirectory
  ) -FailureMessage "下载测试安装包失败。" -MaxAttempts 3 | Out-Null

  $installers = @(
    Get-ChildItem -LiteralPath $temporaryDirectory -Recurse -File |
      Where-Object { $_.Name -like $InstallerPattern }
  )
  if ($installers.Count -ne 1) {
    throw "下载内容中未找到唯一的测试安装程序。"
  }

  $installer = $installers[0]
  if ($DownloadOnly) {
    $keepDownload = $true
    Write-Host "已下载：$($installer.FullName)"
    return
  }

  Write-Host "即将启动安装程序。请先关闭正在运行的 Suzu Lives，再在安装向导中保留原来的安装目录。"
  $process = Start-Process -FilePath $installer.FullName -Wait -PassThru
  if ($process.ExitCode -ne 0) {
    throw "安装程序退出，退出码：$($process.ExitCode)"
  }
  Write-Host "测试版本已安装。"
} catch {
  Write-Error "Suzu Dev Update 失败：$($_.Exception.Message)"
  exit 1
} finally {
  if ($temporaryDirectory -and -not $keepDownload) {
    Remove-UpdateTemporaryDirectory -Path $temporaryDirectory
  }
}
