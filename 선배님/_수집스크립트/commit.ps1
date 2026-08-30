# ============================================================
#  선배님 아카이브 — 브랜치 생성 · 커밋 · 푸시
#  실행: [커밋푸시.bat] 더블클릭
#  다른 작업 중인 파일은 건드리지 않는다. 선배님/ 와 .gitignore 만 스테이징한다.
# ============================================================
$ErrorActionPreference = 'Stop'
$ScriptD = Split-Path -Parent $MyInvocation.MyCommand.Path
$Repo    = Split-Path -Parent (Split-Path -Parent $ScriptD)
Set-Location $Repo
Write-Host ''
Write-Host ('저장소: ' + $Repo) -ForegroundColor Cyan

# 0) 남아 있는 잠금 파일 정리 (마운트에서 지우지 못한 잔재)
$lock = Join-Path $Repo '.git\index.lock'
if (Test-Path $lock) { Remove-Item $lock -Force; Write-Host '  묵은 index.lock 제거' -ForegroundColor Yellow }

# 1) 브랜치
$cur = (git rev-parse --abbrev-ref HEAD).Trim()
$branch = 'archive/senior-blog'
Write-Host ('현재 브랜치: ' + $cur)
$exists = (git branch --list $branch)
if ($exists) { git switch $branch | Out-Null }
else { git switch -c $branch | Out-Null }
Write-Host ('작업 브랜치: ' + $branch) -ForegroundColor Cyan

# 2) 스테이징 — 선배님/ 와 .gitignore 만
git add -- '.gitignore' '선배님'
Write-Host ''
Write-Host '커밋될 파일:' -ForegroundColor Cyan
git diff --cached --stat
$n = (git diff --cached --name-only | Measure-Object -Line).Lines
if ($n -eq 0) { Write-Host '변경 사항이 없습니다.' -ForegroundColor Yellow; Read-Host '엔터'; exit }

# 3) 스테이징되지 않은 다른 작업 확인
Write-Host ''
$other = git status --porcelain | Where-Object { $_ -notmatch '^[AMD]' }
if ($other) {
  Write-Host ('건드리지 않은 다른 변경 ' + $other.Count + '건 — 그대로 둡니다.') -ForegroundColor DarkGray
}

Write-Host ''
$ans = Read-Host ('위 ' + $n + '개 파일을 커밋하고 origin/' + $branch + ' 로 푸시할까요? (y/N)')
if ($ans -ne 'y' -and $ans -ne 'Y') { Write-Host '취소했습니다. 스테이징은 그대로 둡니다.'; Read-Host '엔터'; exit }

# 4) 커밋
$msg = @"
docs(선배님): 블로그 게시판 구조 그대로 보는 아카이브 3종

pillion21 블로그 762편(2006-06-17~2026-08-30)을 수집·정리한 결과와 도구.

- 아카이브.html  게시판·연도 사이드바, 목록형/요약형, 30개씩 페이지네이션,
                 포스트 뷰와 이전/다음 글. 블로그의 정보 구조를 그대로 따랐다.
- 투자철학.html  방법론 5층 구조와 그대로 쓸 때 생길 문제(생존편향·레버리지)
- 내생각.html    원문에 답을 다는 노트. 인용/내 생각/적용/다른 점/질문 5칸
- 수집 도구      전량(collect) · 증분(update) · 보완(retry) · 빌더(build_all/rebuild)

원문 코퍼스(아카이브/·이미지/·_수집원본/)는 타인 저작물이고 358MB이며
스크립트로 재수집 가능하므로 .gitignore 로 제외한다.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01JGe8HmfkPoF2UuVvCcLWQH
"@
$msg | Out-File -FilePath (Join-Path $env:TEMP 'sb_commit_msg.txt') -Encoding UTF8
git commit -F (Join-Path $env:TEMP 'sb_commit_msg.txt')
if ($LASTEXITCODE -ne 0) { Write-Host '커밋 실패' -ForegroundColor Red; Read-Host '엔터'; exit }

# 5) 푸시
Write-Host ''
Write-Host '푸시 중...' -ForegroundColor Cyan
git push -u origin $branch
if ($LASTEXITCODE -ne 0) { Write-Host '푸시 실패 — 인증을 확인하세요.' -ForegroundColor Red; Read-Host '엔터'; exit }

$remote = (git remote get-url origin) -replace '\.git$',''
Write-Host ''
Write-Host '완료.' -ForegroundColor Green
Write-Host ('PR 열기: ' + $remote + '/compare/' + $branch + '?expand=1') -ForegroundColor Green
Write-Host ''
Write-Host ('main 으로 바로 합치려면:  git switch main; git merge ' + $branch + '; git push') -ForegroundColor DarkGray
Read-Host '엔터를 누르면 종료합니다'
