[CmdletBinding()]
param(
  [switch]$DownloadOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not ("System.Net.Http.HttpClient" -as [type])) {
  Add-Type -AssemblyName System.Net.Http
}

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

function Format-ByteSize {
  param(
    [Parameter(Mandatory)]
    [Int64]$Bytes
  )

  if ($Bytes -ge 1GB) {
    return ("{0:N2} GB" -f ($Bytes / 1GB))
  }
  if ($Bytes -ge 1MB) {
    return ("{0:N1} MB" -f ($Bytes / 1MB))
  }
  if ($Bytes -ge 1KB) {
    return ("{0:N1} KB" -f ($Bytes / 1KB))
  }
  return "$Bytes B"
}

function Get-GitHubAccessToken {
  $rawOutput = & gh auth token --hostname github.com 2>&1
  $token = ($rawOutput | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    throw "无法读取 GitHub CLI 的登录凭据。请重新运行 gh auth login。"
  }
  return $token
}

function Get-WorkflowArtifact {
  param(
    [Parameter(Mandatory)]
    [Int64]$RunId
  )

  $artifactJson = Invoke-GitHubCli -CliArguments @(
    "api",
    "--method", "GET",
    "repos/$Repository/actions/runs/$RunId/artifacts?per_page=100"
  ) -FailureMessage "无法查询测试安装包。"
  $artifactResponse = $artifactJson | ConvertFrom-Json
  $matchingArtifacts = @(
    $artifactResponse.artifacts |
      Where-Object { $_.name -eq $ArtifactName -and -not $_.expired }
  )
  if ($matchingArtifacts.Count -ne 1) {
    throw "最新成功构建中没有唯一且未过期的测试安装包。"
  }
  return $matchingArtifacts[0]
}

function Get-GitHubArtifactDownloadUri {
  param(
    [Parameter(Mandatory)]
    [Int64]$ArtifactId,
    [Parameter(Mandatory)]
    [string]$AccessToken
  )

  $handler = $null
  $client = $null
  $request = $null
  $response = $null
  try {
    $handler = New-Object System.Net.Http.HttpClientHandler
    $handler.AllowAutoRedirect = $false
    $client = New-Object System.Net.Http.HttpClient -ArgumentList $handler
    $client.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan

    $requestUri = [Uri]("https://api.github.com/repos/$Repository/actions/artifacts/$ArtifactId/zip")
    $request = New-Object System.Net.Http.HttpRequestMessage -ArgumentList ([System.Net.Http.HttpMethod]::Get), $requestUri
    $request.Headers.Authorization = New-Object System.Net.Http.Headers.AuthenticationHeaderValue -ArgumentList "Bearer", $AccessToken
    $request.Headers.Accept.Add((New-Object System.Net.Http.Headers.MediaTypeWithQualityHeaderValue -ArgumentList "application/vnd.github+json"))
    $request.Headers.UserAgent.ParseAdd("Suzu-Dev-Update")

    $response = $client.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
    $statusCode = [int]$response.StatusCode
    if ($statusCode -lt 300 -or $statusCode -ge 400 -or $null -eq $response.Headers.Location) {
      throw "GitHub 未返回可用的安装包下载链接（HTTP $statusCode）。"
    }

    $location = $response.Headers.Location
    if (-not $location.IsAbsoluteUri) {
      $location = New-Object System.Uri -ArgumentList $requestUri, $location
    }
    return $location
  } finally {
    if ($response) {
      $response.Dispose()
    }
    if ($request) {
      $request.Dispose()
    }
    if ($client) {
      $client.Dispose()
    }
    if ($handler) {
      $handler.Dispose()
    }
  }
}

function Download-GitHubArtifactArchive {
  param(
    [Parameter(Mandatory)]
    [Int64]$ArtifactId,
    [Parameter(Mandatory)]
    [Int64]$ExpectedBytes,
    [Parameter(Mandatory)]
    [string]$DestinationPath,
    [int]$MaxAttempts = 3
  )

  $accessToken = Get-GitHubAccessToken
  try {
    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt += 1) {
      $downloadClient = $null
      $downloadResponse = $null
      $sourceStream = $null
      $fileStream = $null
      $succeeded = $false
      $downloadError = $null
      try {
        Write-Host "正在建立安装包下载连接..."
        $downloadUri = Get-GitHubArtifactDownloadUri -ArtifactId $ArtifactId -AccessToken $accessToken

        $downloadClient = New-Object System.Net.Http.HttpClient
        $downloadClient.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
        $downloadResponse = $downloadClient.GetAsync($downloadUri, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        [void]$downloadResponse.EnsureSuccessStatusCode()

        $contentLength = $downloadResponse.Content.Headers.ContentLength
        $totalBytes = if ($null -ne $contentLength -and [Int64]$contentLength -gt 0) {
          [Int64]$contentLength
        } else {
          $ExpectedBytes
        }
        $totalLabel = if ($totalBytes -gt 0) { Format-ByteSize -Bytes $totalBytes } else { "未知大小" }
        Write-Host "下载：0%（0 B / $totalLabel）"
        if ($totalBytes -gt 0) {
          Write-Progress -Activity "正在下载测试安装包" -Status "下载：0%（0 B / $totalLabel）" -PercentComplete 0
        } else {
          Write-Progress -Activity "正在下载测试安装包" -Status "正在接收数据..."
        }

        $sourceStream = $downloadResponse.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $fileStream = [System.IO.File]::Open($DestinationPath, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        $buffer = New-Object byte[] (1024 * 1024)
        [Int64]$downloadedBytes = 0
        $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
        $lastProgressAt = [TimeSpan]::Zero
        $lastVisiblePercent = 0

        while (($readCount = $sourceStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
          $fileStream.Write($buffer, 0, $readCount)
          $downloadedBytes += $readCount

          if (($stopwatch.Elapsed - $lastProgressAt).TotalMilliseconds -lt 200) {
            continue
          }
          $lastProgressAt = $stopwatch.Elapsed
          $elapsedSeconds = [Math]::Max($stopwatch.Elapsed.TotalSeconds, 0.001)
          $bytesPerSecond = [Int64]($downloadedBytes / $elapsedSeconds)

          if ($totalBytes -gt 0) {
            $percent = [Math]::Min(100, [Int][Math]::Floor(($downloadedBytes / [Double]$totalBytes) * 100))
            $status = "下载：$percent%（$(Format-ByteSize -Bytes $downloadedBytes) / $totalLabel，$(Format-ByteSize -Bytes $bytesPerSecond)/秒）"
            Write-Progress -Activity "正在下载测试安装包" -Status $status -PercentComplete $percent
            if ($percent -ge ($lastVisiblePercent + 10)) {
              Write-Host $status
              $lastVisiblePercent = [Int][Math]::Floor($percent / 10) * 10
            }
          } else {
            $status = "已下载 $(Format-ByteSize -Bytes $downloadedBytes)，$(Format-ByteSize -Bytes $bytesPerSecond)/秒"
            Write-Progress -Activity "正在下载测试安装包" -Status $status
          }
        }

        $stopwatch.Stop()
        Write-Progress -Activity "正在下载测试安装包" -Completed
        $elapsed = [Math]::Max($stopwatch.Elapsed.TotalSeconds, 0.001)
        $averageBytesPerSecond = [Int64]($downloadedBytes / $elapsed)
        Write-Host "下载完成：$(Format-ByteSize -Bytes $downloadedBytes)，耗时 $([Math]::Round($elapsed, 1)) 秒，平均 $(Format-ByteSize -Bytes $averageBytesPerSecond)/秒。"
        $succeeded = $true
      } catch {
        $downloadError = $_
        Write-Progress -Activity "正在下载测试安装包" -Completed
      } finally {
        if ($fileStream) {
          $fileStream.Dispose()
        }
        if ($sourceStream) {
          $sourceStream.Dispose()
        }
        if ($downloadResponse) {
          $downloadResponse.Dispose()
        }
        if ($downloadClient) {
          $downloadClient.Dispose()
        }
      }

      if ($succeeded) {
        return
      }
      if (Test-Path -LiteralPath $DestinationPath) {
        Remove-Item -LiteralPath $DestinationPath -Force
      }
      if ($attempt -lt $MaxAttempts) {
        Write-Host "下载暂时失败，正在重试（$attempt/$MaxAttempts）..."
        Start-Sleep -Seconds 2
        continue
      }
      throw $downloadError
    }
  } finally {
    $accessToken = $null
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
  $artifact = Get-WorkflowArtifact -RunId ([Int64]$run.databaseId)
  $artifactSize = if ($null -ne $artifact.size_in_bytes) { [Int64]$artifact.size_in_bytes } else { 0 }
  $artifactSizeLabel = if ($artifactSize -gt 0) { Format-ByteSize -Bytes $artifactSize } else { "未知大小" }
  Write-Host "正在下载 test 分支的最新成功安装包（$shortSha，约 $artifactSizeLabel）..."
  $archivePath = Join-Path $temporaryDirectory "$ArtifactName.zip"
  Download-GitHubArtifactArchive -ArtifactId ([Int64]$artifact.id) -ExpectedBytes $artifactSize -DestinationPath $archivePath

  Write-Host "正在解压安装包..."
  Expand-Archive -LiteralPath $archivePath -DestinationPath $temporaryDirectory -Force
  Remove-Item -LiteralPath $archivePath -Force

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
