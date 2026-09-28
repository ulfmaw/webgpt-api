param([int]$Port = 17842)
$ErrorActionPreference = "Stop"
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
if ($Port -lt 1024 -or $Port -gt 65535) { throw "Use an unprivileged test port between 1024 and 65535." }

$testHome = Join-Path $env:TEMP ("webgpt-api-clean-" + [guid]::NewGuid().ToString("N"))
$oldHome = $env:WEBGPT_HOME
$server = $null
$stdout = Join-Path $testHome "serve.out"
$stderr = Join-Path $testHome "serve.err"
New-Item -ItemType Directory -Path $testHome -Force | Out-Null
try {
  $env:WEBGPT_HOME = $testHome
  Write-Host "A separate login window will open. Complete normal sign-in there; no credentials are printed or saved in the repository."
  & node src/cli.js setup
  if ($LASTEXITCODE -ne 0) { throw "first_login_failed" }

  $server = Start-Process -FilePath node -ArgumentList @("src/cli.js", "serve", "--port", "$Port") `
    -WorkingDirectory (Get-Location).Path -WindowStyle Hidden `
    -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  $ready = $false
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue) { $ready = $true; break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $ready) { throw "temporary_service_not_ready" }

  & node scripts/first-run-probe.js "$Port"
  if ($LASTEXITCODE -ne 0) { throw "first_run_generation_failed" }
} catch {
  Write-Host (ConvertTo-Json @{ test = "isolated_first_run"; passed = $false; code = $_.Exception.Message } -Compress)
  exit 1
} finally {
  if ($server -and -not $server.HasExited) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  if ($null -eq $oldHome) { Remove-Item Env:WEBGPT_HOME -ErrorAction SilentlyContinue } else { $env:WEBGPT_HOME = $oldHome }
  if ((Split-Path -Parent $testHome) -eq $env:TEMP -and (Split-Path -Leaf $testHome) -like "webgpt-api-clean-*") {
    Remove-Item -LiteralPath $testHome -Recurse -Force -ErrorAction SilentlyContinue
  }
}
