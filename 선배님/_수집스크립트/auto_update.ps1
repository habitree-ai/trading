# ============================================================
#  자동 증분 수집 — 예약 작업(SeniorBlogUpdate)이 매일 아침 실행한다.
#
#  update.ps1 -Unattended  →  rebuild.py  →  새 글로 바뀌는 산출물 2개(인덱스.csv · 내생각.html)를
#  origin/main 위에 직접 커밋해 푸시한다. 커밋은 임시 인덱스 + commit-tree 로 만들므로
#  사용자의 작업 트리·브랜치·인덱스·미푸시 커밋은 건드리지 않는다. 로컬 main 이 origin/main 과
#  같을 때만 fast-forward 로 따라간다(그 밖엔 산출물 2개가 작업 트리에 수정 상태로 남는다).
#
#  실행: schedule.ps1 로 등록한 예약 작업, 또는 손으로
#        powershell -NoProfile -ExecutionPolicy Bypass -File auto_update.ps1 [-DryRun]
#    -DryRun  커밋 객체까지 만들고 푸시는 --dry-run 으로만. 로컬 트리도 안 건드린다
#  로그: _수집원본\자동수집로그.txt   (수집 상세는 증분로그.txt)
#  종료 코드: 0 성공·변경 없음 / 1 실패 (예약 작업 '마지막 실행 결과'로 보인다)
# ============================================================
param([switch]$DryRun)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch { }
$env:PYTHONIOENCODING = 'utf-8'

$ScriptD  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root     = Split-Path -Parent $ScriptD            # 선배님/
$Repo     = Split-Path -Parent $Root               # 저장소 루트
$RawD     = Join-Path $Root '_수집원본'
$LogF     = Join-Path $RawD '자동수집로그.txt'
$NewF     = Join-Path $RawD '신규글.json'
$TaskName = 'SeniorBlogUpdate'
# 새 글로 내용이 바뀌는 커밋 대상. 아카이브.html 은 데이터를 외부 js 로 읽고,
# 투자철학.html 은 정리 문서만 담으므로 글이 늘어도 바뀌지 않는다.
$Outputs  = @('선배님/인덱스.csv', '선배님/내생각.html')
$utf8NoBom = New-Object Text.UTF8Encoding($false)

function Log([string]$m) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $m
  Write-Host $line
  Add-Content -Path $LogF -Value $line -Encoding UTF8
}
function Fail([string]$m) { Log ('FAIL ' + $m); Log '=== END (fail) ==='; exit 1 }
function Tool([string]$name, [string]$fallback) {
  # 실행 파일만, PATH 순서상 첫 번째 — 같은 이름의 함수·별칭이 잡히면 Source 가 비고,
  # python 은 스토어 스텁(WindowsApps)이 두 번째로 딸려 온다
  $c = @(Get-Command $name -CommandType Application -ErrorAction SilentlyContinue) | Select-Object -First 1
  if ($c) { return $c.Source }
  if ($fallback -and (Test-Path $fallback)) { return $fallback }
  Fail ($name + ' 을 찾지 못했습니다 — 예약 작업 환경의 PATH 를 확인하세요')
}
# git 은 진행 메시지를 stderr 로 쓴다 — 오류로 승격하지 않고 문자열로 모은다
function GitRun {
  $out = & $git @args 2>&1 | ForEach-Object { [string]$_ }
  return [pscustomobject]@{ Code = $LASTEXITCODE; Out = (@($out | Where-Object { $_ -ne '' }) -join "`n") }
}
function GitMust {
  $r = GitRun @args
  if ($r.Code -ne 0) { Fail ('git ' + ($args -join ' ') + "`n" + $r.Out) }
  return $r.Out
}

Set-Location $Repo
Log ('=== AUTO UPDATE start' + $(if ($DryRun) { ' (dry-run)' } else { '' }) + ' ===')
$git = Tool 'git'    'C:\Program Files\Git\cmd\git.exe'
$gh  = Tool 'gh'     'C:\Program Files\GitHub CLI\gh.exe'
$py  = Tool 'python' $null

# ---------------- 1) 증분 수집 ----------------
# 신규글.json 은 update.ps1 이 끝까지 돌았을 때만 다시 쓰인다 — 이전 실행 잔재를 읽지 않도록 먼저 지운다
if (Test-Path $NewF) { Remove-Item $NewF -Force }
& (Join-Path $ScriptD 'update.ps1') -Unattended
$rc = $LASTEXITCODE
if (-not (Test-Path $NewF)) { Fail ('update.ps1 이 신규글.json 을 남기지 않았습니다 (exit ' + $rc + ') — 증분로그.txt 확인') }
$newPosts = @()
try {
  $j = Get-Content -Path $NewF -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($j) { $newPosts = @($j) }
} catch { Fail ('신규글.json 파싱 실패: ' + $_.Exception.Message) }
if ($newPosts.Count -eq 0) { Log '새 글 없음' }
else {
  Log ('새 글 ' + $newPosts.Count + '편')
  foreach ($p in $newPosts) { Log ('  + ' + $p.date + ' [' + $p.categoryPath + '] ' + $p.title) }
}

# ---------------- 2) 파생물 재생성 ----------------
# 새 글이 없어도 돌린다 — 지난 실행에서 푸시가 실패했으면 아래 3)에서 차이가 남아 다시 올라간다
$rb = & $py (Join-Path $ScriptD 'rebuild.py') 2>&1 | ForEach-Object { [string]$_ }
if ($LASTEXITCODE -ne 0) { Fail ("rebuild.py 실패`n" + ($rb -join "`n")) }
$summary = @($rb | Where-Object { $_ -match '^글 ' })
if ($summary.Count -eq 0) { $summary = @($rb | Where-Object { $_ -ne '' } | Select-Object -Last 1) }
Log ('rebuild: ' + ($summary -join ' '))

# ---------------- 3) origin/main 위에 커밋 · 푸시 ----------------
# 사용자 환경변수 GITHUB_TOKEN(cdhrich-biz PAT)은 이 저장소에 푸시 권한이 없다 — 이 프로세스에서만 비우고
# gh 키링의 habitree-ai 토큰을 쓴다. 활성 계정은 바꾸지 않는다.
$env:GITHUB_TOKEN = ''
$env:GH_TOKEN = ''
$tok = (& $gh auth token -u habitree-ai 2>$null | Out-String).Trim()
if (-not $tok) { Fail 'gh 키링에서 habitree-ai 토큰을 얻지 못했습니다 (gh auth status 확인)' }
$env:GH_TOKEN = $tok
$authArgs = @('-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential')

$null = GitMust @authArgs fetch --quiet origin main
$originMain = GitMust rev-parse --verify refs/remotes/origin/main

# 임시 인덱스에 origin/main 트리를 읽고 산출물만 갈아 끼운다 — 사용자 인덱스는 그대로
$tmpIdx = Join-Path $env:TEMP ('senior_auto_index_' + $PID)
$env:GIT_INDEX_FILE = $tmpIdx
$null = GitMust read-tree $originMain
foreach ($f in $Outputs) {
  $blob = GitMust hash-object -w -- $f
  $null = GitMust update-index --add --cacheinfo ('100644,' + $blob + ',' + $f)
}
$tree = GitMust write-tree
Remove-Item Env:GIT_INDEX_FILE
Remove-Item $tmpIdx -Force -ErrorAction SilentlyContinue

$baseTree = GitMust rev-parse ($originMain + '^{tree}')
if ($tree -eq $baseTree) { Log ('origin/main(' + $originMain.Substring(0, 7) + ') 과 산출물 차이 없음 — 커밋 생략'); Log '=== END ==='; exit 0 }

# 커밋 메시지의 새 글 목록은 이번 실행의 신규글.json 이 아니라 origin/main 의 색인과 비교해 뽑는다 —
# 손으로 업데이트.bat 을 돌린 뒤라도, 지난 푸시가 실패했더라도 메시지가 실제 차이를 말하도록
$bom = [string][char]0xFEFF
$oldCsv = (GitRun show ($originMain + ':선배님/인덱스.csv')).Out -replace $bom, ''
$newCsv = (Get-Content -Path (Join-Path $Repo '선배님/인덱스.csv') -Raw -Encoding UTF8) -replace $bom, ''
$oldUrls = @{}
foreach ($r in @($oldCsv | ConvertFrom-Csv)) { $oldUrls[$r.'원문URL'] = $true }
$added = @($newCsv | ConvertFrom-Csv | Where-Object { -not $oldUrls.ContainsKey($_.'원문URL') })

$today = Get-Date -Format 'yyyy-MM-dd'
if ($added.Count -gt 0) {
  $subject = 'docs(선배님): 새 글 ' + $added.Count + '편 자동 수집 (' + $today + ')'
  $lines = @($subject, '')
  foreach ($r in @($added | Select-Object -First 30)) { $lines += ('- ' + $r.'날짜' + ' [' + $r.'게시판' + '] ' + $r.'제목') }
  if ($added.Count -gt 30) { $lines += ('- … 외 ' + ($added.Count - 30) + '편') }
} else {
  $subject = 'docs(선배님): 아카이브 색인 갱신 (' + $today + ')'
  $lines = @($subject)
}
$lines += ''
$lines += '새 글이 올라오면 색인(인덱스.csv)과 노트 뷰어(내생각.html)가 바뀐다. 둘 다 수집 산출물이라'
$lines += '손으로 고치지 않고 예약 작업이 받은 날 그대로 올린다. 정리 문서 3종은 사람이 읽고 고친다.'
$lines += ''
$lines += ('자동 수집: 선배님/_수집스크립트/auto_update.ps1 (예약 작업 ' + $TaskName + ')')
$msgF = Join-Path $env:TEMP 'senior_auto_commit_msg.txt'
[IO.File]::WriteAllText($msgF, (($lines -join "`n") + "`n"), $utf8NoBom)
$commit = GitMust commit-tree $tree -p $originMain -F $msgF
Remove-Item $msgF -Force -ErrorAction SilentlyContinue
Log ('커밋 ' + $commit.Substring(0, 7) + ' — ' + $subject)
Log (GitMust -c core.quotepath=false show --stat --format= $commit)

if ($DryRun) {
  $r = GitRun @authArgs push --dry-run origin ($commit + ':refs/heads/main')
  Log ('DRY RUN push (exit ' + $r.Code + '): ' + $r.Out)
  Log '=== END (dry-run) ==='
  exit 0
}
$r = GitRun @authArgs push origin ($commit + ':refs/heads/main')
if ($r.Code -ne 0) { Fail ("push 실패 — 다음 실행에서 다시 시도한다`n" + $r.Out) }
Log ('push 완료 → origin/main ' + $commit.Substring(0, 7))

# ---------------- 4) 로컬 트리 동기화 ----------------
# 로컬 main 이 방금 전 origin/main 과 같고 git 작업 중이 아닐 때만 fast-forward.
$head   = (GitRun rev-parse --verify HEAD).Out
$branch = (GitRun symbolic-ref --short -q HEAD).Out
$busy   = (Test-Path (Join-Path $Repo '.git\rebase-merge')) -or (Test-Path (Join-Path $Repo '.git\rebase-apply')) -or
          (Test-Path (Join-Path $Repo '.git\MERGE_HEAD'))   -or (Test-Path (Join-Path $Repo '.git\index.lock'))
if ($branch -eq 'main' -and $head -eq $originMain -and -not $busy) {
  # 산출물을 HEAD 판으로 되돌린 뒤(내용은 방금 올린 것과 같다) ff — 다른 수정 파일은 그대로
  $null = GitMust checkout --quiet -- @Outputs
  $null = GitMust merge --ff-only --quiet $commit
  Log ('로컬 main fast-forward → ' + $commit.Substring(0, 7))
} else {
  $why = if ($busy) { 'git 작업 진행 중' } elseif ($branch -ne 'main') { '현재 브랜치가 main 이 아님(' + $branch + ')' } else { '로컬 main 에 미푸시 커밋이 있음' }
  Log ('로컬 트리 동기화 생략 — ' + $why + '. 산출물 2개는 작업 트리에 수정 상태로 남는다(내용은 origin/main 과 같다). 다음에  git pull --rebase --autostash')
}
Log '=== END ==='
exit 0
