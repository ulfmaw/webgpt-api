$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)

function Get-TaskSha256([string]$Path) {
  if (Get-Command Get-FileHash -ErrorAction SilentlyContinue) {
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $lines = & certutil.exe -hashfile $Path SHA256 2>$null
  foreach ($line in $lines) {
    $candidate = ($line -replace '\s', '')
    if ($candidate -match '^[0-9a-fA-F]{64}$') { return $candidate.ToLowerInvariant() }
  }
  throw 'No SHA-256 verifier is available.'
}

function Get-TaskNodePath {
  $taskNode = Get-Command node -ErrorAction SilentlyContinue
  if ($taskNode) {
    $taskVersion = [version]((& $taskNode.Source --version) -replace '^v', '')
    if ($taskVersion -ge [version]'24.14.0') { return $taskNode.Source }
  }

  $taskArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { 'arm64' } else { 'x64' }
  $taskHash = if ($taskArch -eq 'arm64') { '8c5fd45a4a1fd3cc4a6f07da8803b05194108906cb6fb7d962448a12582a592' } else { '63c259c81e5d472b5f11c8d506070130cb04a1ecf84b80377a34ed6ec9048088' }
  $taskRuntime = Join-Path $env:LOCALAPPDATA "webgpt-api\runtime\node-v24.14.0-$taskArch"
  New-Item -ItemType Directory -Path $taskRuntime -Force | Out-Null
  $taskNodePath = Join-Path $taskRuntime 'node.exe'
  if ((Test-Path -LiteralPath $taskNodePath) -and (Get-TaskSha256 $taskNodePath) -ne $taskHash) {
    throw 'Cached runtime checksum mismatch. It was not executed or overwritten.'
  }
  if (-not (Test-Path -LiteralPath $taskNodePath)) {
    $taskDownload = Join-Path $taskRuntime ("download-" + [guid]::NewGuid().ToString('N') + '.tmp')
    try {
      Write-Host 'Downloading verified portable runtime from nodejs.org...'
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v24.14.0/win-$taskArch/node.exe" -OutFile $taskDownload -TimeoutSec 120
      if ((Get-TaskSha256 $taskDownload) -ne $taskHash) { throw 'Runtime download checksum mismatch.' }
      Move-Item -LiteralPath $taskDownload -Destination $taskNodePath
    } finally {
      if (Test-Path -LiteralPath $taskDownload) { Remove-Item -LiteralPath $taskDownload }
    }
  }
  return $taskNodePath
}

$taskNodePath = Get-TaskNodePath
if ($args -and $args.Count -gt 0) {
  & $taskNodePath src/cli.js run -- @args
} else {
  & $taskNodePath src/cli.js shell
}
exit $LASTEXITCODE
