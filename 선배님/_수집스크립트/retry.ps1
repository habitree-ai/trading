
# ============================================================
#  Final retry - uses Windows curl.exe (passes URL verbatim,
#  avoiding .NET Uri re-encoding of the fullwidth chars in the
#  Naver filenames).  run via [보완수집시작.bat]
# ============================================================
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$ScriptD = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root    = Split-Path -Parent $ScriptD
$ImgD    = Join-Path $Root '이미지'
$RawD    = Join-Path $Root '_수집원본'
$ListF   = Join-Path $RawD '누락이미지.json'
$LogF    = Join-Path $RawD '보완로그.txt'

function Log([string]$m) {
  $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m
  Write-Host $line
  Add-Content -Path $LogF -Value $line -Encoding UTF8
}
Set-Content -Path $LogF -Value ('=== FINAL RETRY (curl) ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ===') -Encoding UTF8

$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path $curl)) { $curl = 'curl.exe' }
Log ('curl: ' + $curl)

$items = Get-Content -Path $ListF -Raw -Encoding UTF8 | ConvertFrom-Json
Log ('targets: ' + $items.Count)
$UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'
$ok = 0; $ng = 0
foreach ($it in $items) {
  $dir = Join-Path $ImgD $it.dir
  if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
  $fp = Join-Path $dir $it.file
  if (Test-Path $fp) { $ok = $ok + 1; continue }
  $got = $false
  foreach ($u in $it.urls) {
    if ($got) { break }
    & $curl -s -L --max-time 25 -A $UA -e 'https://blog.naver.com/pillion21' -o $fp $u 2>$null
    if (Test-Path $fp) {
      $len = (Get-Item $fp).Length
      if ($len -gt 400) { $ok = $ok + 1; $got = $true; Log ('OK   ' + $it.file + '  ' + $len + 'B') }
      else { Remove-Item $fp -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Milliseconds 120
  }
  if (-not $got) { $ng = $ng + 1; Log ('FAIL ' + $it.file) }
}
Log ('=== FINAL RETRY DONE === ok ' + $ok + ' / fail ' + $ng)
Write-Host ''
Write-Host 'COMPLETE. Tell Claude: final retry finished.' -ForegroundColor Green
