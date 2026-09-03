# ============================================================
#  자동 수집 예약 작업 등록 / 해제 — SeniorBlogUpdate
#  매일 07:00 에 auto_update.ps1 을 현재 사용자로 실행한다. 그 시각에 PC 가 꺼져 있거나
#  로그인 전이면 다음에 가능할 때 바로 실행한다(StartWhenAvailable). 배터리여도 돈다.
#
#  실행: powershell -NoProfile -ExecutionPolicy Bypass -File schedule.ps1 [-At '07:00'] [-Remove]
#  확인: Get-ScheduledTaskInfo SeniorBlogUpdate   (LastTaskResult 0 = 정상, 1 = 실패 → 자동수집로그.txt)
#  지금 실행: Start-ScheduledTask SeniorBlogUpdate
# ============================================================
param([switch]$Remove, [string]$At = '07:00')
$ErrorActionPreference = 'Stop'
$TaskName = 'SeniorBlogUpdate'
$ScriptD  = Split-Path -Parent $MyInvocation.MyCommand.Path
$Target   = Join-Path $ScriptD 'auto_update.ps1'

if ($Remove) {
  if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host ('해제: ' + $TaskName)
  } else { Write-Host ('등록된 작업 없음: ' + $TaskName) }
  exit
}

$action    = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $ScriptD `
               -Argument ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $Target + '"')
$trigger   = New-ScheduledTaskTrigger -Daily -At $At
$settings  = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
               -RunOnlyIfNetworkAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Hours 1)
# 사용자명은 도메인(로컬 계정이면 PC 이름)을 붙여야 등록된다 — 이름만 주면 "parameter is incorrect"
$principal = New-ScheduledTaskPrincipal -UserId ($env:USERDOMAIN + '\' + $env:USERNAME) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description '선배님 블로그(pillion21) 새 글 자동 수집 — 선배님/_수집스크립트/auto_update.ps1' -Force | Out-Null
$info = Get-ScheduledTaskInfo -TaskName $TaskName
Write-Host ('등록: ' + $TaskName + ' — 매일 ' + $At + ', 다음 실행 ' + $info.NextRunTime)
