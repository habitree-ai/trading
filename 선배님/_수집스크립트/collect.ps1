
# =====================================================================
#  Naver Blog (pillion21) Full Collector  -  run via [수집시작.bat]
# =====================================================================
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$B       = 'pillion21'
$ScriptD = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root    = Split-Path -Parent $ScriptD
$ArcD    = Join-Path $Root '아카이브'
$ImgD    = Join-Path $Root '이미지'
$RawD    = Join-Path $Root '_수집원본'
$HtmlD   = Join-Path $RawD '원본html'
$LogF    = Join-Path $RawD '진행로그.txt'
$IdxF    = Join-Path $RawD '인덱스.json'
$CatF    = Join-Path $RawD '게시판.json'
foreach ($d in @($ArcD,$ImgD,$RawD,$HtmlD)) {
  if (-not (Test-Path $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
}

$utf8NoBom = New-Object Text.UTF8Encoding($false)
function Log([string]$m) {
  $line = '[' + (Get-Date -Format 'HH:mm:ss') + '] ' + $m
  Write-Host $line
  Add-Content -Path $LogF -Value $line -Encoding UTF8
}
Set-Content -Path $LogF -Value ('=== START ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ===') -Encoding UTF8

Add-Type -AssemblyName System.Net.Http
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::GZip -bor [System.Net.DecompressionMethods]::Deflate
$cli = New-Object System.Net.Http.HttpClient($handler)
$cli.Timeout = [TimeSpan]::FromSeconds(40)
$cli.DefaultRequestHeaders.Add('User-Agent','Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')
$cli.DefaultRequestHeaders.Add('Referer','https://blog.naver.com/' + $B)
$cli.DefaultRequestHeaders.Add('Accept-Language','ko-KR,ko;q=0.9')

function Get-Str([string]$u) {
  for ($a=0; $a -lt 3; $a++) {
    try { return $cli.GetStringAsync($u).GetAwaiter().GetResult() } catch { Start-Sleep -Milliseconds 700 }
  }
  return $null
}
function Get-Bytes([string]$u) {
  for ($a=0; $a -lt 2; $a++) {
    try { return $cli.GetByteArrayAsync($u).GetAwaiter().GetResult() } catch { Start-Sleep -Milliseconds 500 }
  }
  return $null
}
function Safe([string]$s, [int]$max) {
  if ($max -le 0) { $max = 60 }
  if ([string]::IsNullOrWhiteSpace($s)) { return '미분류' }
  $r = $s -replace '\s*>\s*','__'
  $r = [regex]::Replace($r,'[\\/:\*\?"<>\|]','_')
  $r = [regex]::Replace($r,'[\x00-\x1f]','')
  $r = [regex]::Replace($r,'\s+',' ')
  $r = $r.Trim()
  if ($r.Length -gt $max) { $r = $r.Substring(0,$max) }
  $r = $r.TrimEnd('.',' ')
  if ([string]::IsNullOrWhiteSpace($r)) { return '무제' }
  return $r
}
function NormDate([string]$d) {
  $m = [regex]::Match([string]$d,'(\d{4})\D+(\d{1,2})\D+(\d{1,2})')
  if ($m.Success) {
    return ('{0:0000}-{1:00}-{2:00}' -f [int]$m.Groups[1].Value,[int]$m.Groups[2].Value,[int]$m.Groups[3].Value)
  }
  return '0000-00-00'
}
function Dec([string]$s) {
  if ([string]::IsNullOrEmpty($s)) { return '' }
  try { return [System.Uri]::UnescapeDataString(($s -replace '\+',' ')) } catch { return $s }
}
function Get-Container([string]$html, [string]$marker) {
  if ([string]::IsNullOrEmpty($html)) { return '' }
  $i = $html.IndexOf($marker)
  if ($i -lt 0) { return '' }
  $gt = $html.IndexOf('>', $i)
  if ($gt -lt 0) { return '' }
  $depth = 1
  $pos = $gt + 1
  $rx = [regex]'</?div\b'
  while ($true) {
    $m = $rx.Match($html, $pos)
    if (-not $m.Success) { return $html.Substring($gt+1) }
    if ($m.Value -eq '<div') { $depth = $depth + 1 }
    else {
      $depth = $depth - 1
      if ($depth -eq 0) { return $html.Substring($gt+1, $m.Index - $gt - 1) }
    }
    $pos = $m.Index + $m.Length
  }
}
function ConvertTo-Text([string]$h) {
  if ([string]::IsNullOrEmpty($h)) { return '' }
  $t = [regex]::Replace($h,'(?s)<script.*?</script>','')
  $t = [regex]::Replace($t,'(?s)<style.*?</style>','')
  $t = [regex]::Replace($t,'(?i)<br\s*/?>',"`n")
  $t = [regex]::Replace($t,'(?i)</(p|div|h[1-6]|li|tr|td|section|blockquote)>',"`n")
  $t = [regex]::Replace($t,'(?s)<[^>]+>','')
  $t = [System.Net.WebUtility]::HtmlDecode($t)
  $t = $t -replace "`r`n","`n"
  $t = $t -replace ([string][char]0x200B),''
  $t = $t -replace ([string][char]0xA0),' '
  $t = [regex]::Replace($t,'[ \t]+\n',"`n")
  $t = [regex]::Replace($t,'\n{3,}',"`n`n")
  return $t.Trim()
}
function Parse-PostList([string]$t) {
  $res = @()
  if ([string]::IsNullOrEmpty($t)) { return $res }
  try {
    $j = $t | ConvertFrom-Json
    if ($j.postList) {
      foreach ($p in $j.postList) {
        $res += [pscustomobject]@{ logNo=[string]$p.logNo; title=[string]$p.title; addDate=[string]$p.addDate }
      }
      return $res
    }
  } catch { }
  foreach ($m in [regex]::Matches($t,'\{[^{}]*\}')) {
    $c = $m.Value
    $a = [regex]::Match($c,'logNo["'']?\s*:\s*["'']?(\d+)')
    if (-not $a.Success) { continue }
    $b2 = [regex]::Match($c,'title["'']?\s*:\s*["'']([^"'']*)["'']')
    $c2 = [regex]::Match($c,'addDate["'']?\s*:\s*["'']([^"'']*)["'']')
    $res += [pscustomobject]@{ logNo=$a.Groups[1].Value; title=$b2.Groups[1].Value; addDate=$c2.Groups[1].Value }
  }
  return $res
}
function Get-Total([string]$t) {
  $m = [regex]::Match([string]$t,'totalCount["'']?\s*:\s*["'']?(\d+)')
  if ($m.Success) { return [int]$m.Groups[1].Value }
  return 0
}

# ---------------- 1) categories ----------------
Log 'category list'
$cats = New-Object System.Collections.ArrayList
function Add-Cat($no,$name,$parent,$cnt) {
  if ($null -eq $no) { return }
  if ([string]::IsNullOrWhiteSpace([string]$name)) { return }
  $k = [string]$no
  foreach ($c in $cats) { if ($c.no -eq $k) { return } }
  $pv = $null
  if ($null -ne $parent) { $pv = [string]$parent }
  $o = New-Object psobject
  $o | Add-Member NoteProperty no $k
  $nmv = ([string]$name).Trim()
  $o | Add-Member NoteProperty name $nmv
  $o | Add-Member NoteProperty parent $pv
  $o | Add-Member NoteProperty cnt $cnt
  $o | Add-Member NoteProperty path ''
  [void]$cats.Add($o)
}
function Walk($arr,$parent) {
  foreach ($c in $arr) {
    $no = $c.categoryNo
    if ($null -eq $no) { $no = $c.categoryId }
    $nm = $c.categoryName
    if (-not $nm) { $nm = $c.name }
    $pn = $parent
    if ($null -eq $pn) { $pn = $c.parentCategoryNo }
    $ct = $c.postCnt
    if ($null -eq $ct) { $ct = $c.postCount }
    Add-Cat $no $nm $pn $ct
    $names = $c.PSObject.Properties.Name
    foreach ($f in @('categoryList','childCategoryList','children','subCategoryList')) {
      if ($names -contains $f) {
        $kids = $c.$f
        if ($kids) { Walk $kids $no }
      }
    }
  }
}
foreach ($u in @(('https://blog.naver.com/api/blogs/'+$B+'/category-list'),('https://m.blog.naver.com/api/blogs/'+$B+'/category-list'))) {
  if ($cats.Count -gt 0) { break }
  $t = Get-Str $u
  if (-not $t) { continue }
  try {
    $j = $t | ConvertFrom-Json
    $r = $j.result
    if (-not $r) { $r = $j }
    $rn = $r.PSObject.Properties.Name
    foreach ($f in @('mylogCategoryList','categoryList','categories')) {
      if ($rn -contains $f) {
        $arr = $r.$f
        if ($arr) { Walk $arr $null; break }
      }
    }
  } catch { Log ('category parse fail: ' + $_.Exception.Message) }
}
foreach ($c in $cats) {
  $parts = @($c.name)
  $p = $c.parent
  $g = 0
  while ($p -and $g -lt 10) {
    $pc = $null
    foreach ($x in $cats) { if ($x.no -eq $p) { $pc = $x; break } }
    if (-not $pc) { break }
    $parts = @($pc.name) + $parts
    $p = $pc.parent
    $g = $g + 1
  }
  $c.path = ($parts -join ' > ')
}
Log ('categories: ' + $cats.Count)
foreach ($c in $cats) { Log ('  - [' + $c.no + '] ' + $c.path) }
$cats | ConvertTo-Json -Depth 5 | Out-File -FilePath $CatF -Encoding UTF8

# ---------------- 2) post list per category ----------------
$meta  = @{}
$order = New-Object System.Collections.ArrayList
function List-Cat([string]$catNo,[string]$label,[string]$catName,[string]$catPath) {
  $total = -1
  $got = 0
  for ($page=1; $page -le 400; $page++) {
    $u = 'https://blog.naver.com/PostTitleListAsync.naver?blogId=' + $B + '&viewdate=&currentPage=' + $page + '&categoryNo=' + $catNo + '&parentCategoryNo=&countPerPage=30'
    $t = Get-Str $u
    if (-not $t) { break }
    if ($total -lt 0) { $total = Get-Total $t }
    $items = @(Parse-PostList $t)
    if ($items.Count -eq 0) { break }
    foreach ($it in $items) {
      $k = $it.logNo
      if (-not $meta.ContainsKey($k)) {
        $o = New-Object psobject
        $o | Add-Member NoteProperty logNo $k
        $o | Add-Member NoteProperty title (Dec $it.title)
        $o | Add-Member NoteProperty date (NormDate $it.addDate)
        $o | Add-Member NoteProperty categoryName ''
        $o | Add-Member NoteProperty categoryPath ''
        $o | Add-Member NoteProperty url ('https://blog.naver.com/' + $B + '/' + $k)
        $meta[$k] = $o
        [void]$order.Add($k)
      }
      if ($catNo -ne '') {
        $meta[$k].categoryName = $catName
        $meta[$k].categoryPath = $catPath
      }
      $got = $got + 1
    }
    Log ('list ' + $label + ' p' + $page + ' -> ' + $got + '/' + $total + ' (all ' + $order.Count + ')')
    if ($total -gt 0 -and $got -ge $total) { break }
    Start-Sleep -Milliseconds 180
  }
}
foreach ($c in $cats) { List-Cat $c.no ('[' + $c.path + ']') $c.name $c.path }
List-Cat '' '[ALL]' '' ''
Log ('unique posts: ' + $order.Count)

# ---------------- 3) bodies + images ----------------
$catIndex = @{}
$n = 0
foreach ($c in $cats) {
  $n = $n + 1
  $catIndex[$c.path] = ('{0:00}_{1}' -f $n, (Safe $c.name 50))
}
$records   = New-Object System.Collections.ArrayList
$usedNames = @{}
$done = 0; $fail = 0; $imgOK = 0; $imgNG = 0; $i = 0

foreach ($k in $order) {
  $i = $i + 1
  $m = $meta[$k]
  $html = $null
  foreach ($u in @(('https://blog.naver.com/PostView.naver?blogId='+$B+'&logNo='+$k+'&redirect=Dlog&widgetTypeCall=true&directAccess=false'),
                   ('https://m.blog.naver.com/PostView.naver?blogId='+$B+'&logNo='+$k))) {
    $h = Get-Str $u
    if ($h) {
      if ($h.Contains('se-main-container') -or $h.Contains('postViewArea') -or $h.Contains('viewTypeSelector')) { $html = $h; break }
    }
  }
  if (-not $html) { Log ('FAIL body ' + $k); $fail = $fail + 1; continue }

  [IO.File]::WriteAllText((Join-Path $HtmlD ($k + '.html')), $html, $utf8NoBom)

  $inner = Get-Container $html 'class="se-main-container"'
  if ([string]::IsNullOrEmpty($inner)) { $inner = Get-Container $html 'id="postViewArea"' }
  if ([string]::IsNullOrEmpty($inner)) { $inner = Get-Container $html 'id="viewTypeSelector"' }
  if ($null -eq $inner) { $inner = '' }
  $text = ConvertTo-Text $inner

  if ([string]::IsNullOrWhiteSpace($m.categoryPath)) {
    $cm = [regex]::Match($html,'["'']categoryName["'']\s*:\s*["'']([^"'']+)["'']')
    if ($cm.Success) {
      $m.categoryName = (Dec $cm.Groups[1].Value)
      $m.categoryPath = $m.categoryName
    }
  }
  if ([string]::IsNullOrWhiteSpace($m.categoryPath)) { $m.categoryPath = '미분류'; $m.categoryName = '미분류' }
  $catFolder = $catIndex[$m.categoryPath]
  if (-not $catFolder) { $catFolder = '99_' + (Safe $m.categoryName 50) }
  $catSafe = Safe $m.categoryPath 60

  $imgUrls = @()
  foreach ($mm in [regex]::Matches($inner,'(?i)<img[^>]*?(?:data-lazy-src|src)\s*=\s*"([^"]+)"')) {
    $iu = $mm.Groups[1].Value
    if ($iu -match 'blogpfthumb|ssl\.pstatic\.net/static|static\.naver|blank\.gif') { continue }
    $iu = $iu.Split('?')[0]
    if ($iu -notmatch '^https?://') { continue }
    if ($imgUrls -notcontains $iu) { $imgUrls += $iu }
  }
  $imgFiles = @()
  if ($imgUrls.Count -gt 0) {
    $imgDir = Join-Path $ImgD $catSafe
    if (-not (Test-Path $imgDir)) { New-Item -ItemType Directory -Path $imgDir -Force | Out-Null }
    $ii = 0
    foreach ($iu in $imgUrls) {
      $ii = $ii + 1
      $ext = 'jpg'
      $em = [regex]::Match($iu,'\.(jpe?g|png|gif|webp|bmp)$','IgnoreCase')
      if ($em.Success) { $ext = $em.Groups[1].Value.ToLower() }
      $fn = ('{0}_{1}_{2:00}.{3}' -f $m.date, $k, $ii, $ext)
      $fp = Join-Path $imgDir $fn
      if (Test-Path $fp) { $imgFiles += ($catSafe + '/' + $fn); $imgOK = $imgOK + 1; continue }
      $bytes = Get-Bytes ($iu + '?type=w966')
      if ($null -eq $bytes -or $bytes.Length -lt 100) { $bytes = Get-Bytes $iu }
      if ($null -ne $bytes -and $bytes.Length -gt 100) {
        [IO.File]::WriteAllBytes($fp, $bytes)
        $imgFiles += ($catSafe + '/' + $fn)
        $imgOK = $imgOK + 1
      } else { $imgNG = $imgNG + 1 }
      Start-Sleep -Milliseconds 40
    }
  }

  $links = New-Object System.Collections.ArrayList
  foreach ($mm in [regex]::Matches($inner,'(?is)<a[^>]+href="(https?://[^"]+)"[^>]*>(.*?)</a>')) {
    $lo = New-Object psobject
    $lo | Add-Member NoteProperty href $mm.Groups[1].Value
    $lo | Add-Member NoteProperty text (ConvertTo-Text $mm.Groups[2].Value)
    [void]$links.Add($lo)
  }
  $tags = @()
  foreach ($mm in [regex]::Matches($html,'"tagName"\s*:\s*"([^"]+)"')) {
    $t2 = Dec $mm.Groups[1].Value
    if ($tags -notcontains $t2) { $tags += $t2 }
  }

  $arcSub = Join-Path $ArcD $catFolder
  if (-not (Test-Path $arcSub)) { New-Item -ItemType Directory -Path $arcSub -Force | Out-Null }
  $base = ($m.date + '_' + (Safe $m.title 70))
  $cand = $base
  $c2 = 1
  while ($usedNames.ContainsKey($catFolder + '/' + $cand)) { $c2 = $c2 + 1; $cand = $base + '(' + $c2 + ')' }
  $usedNames[$catFolder + '/' + $cand] = $true
  $mdPath = Join-Path $arcSub ($cand + '.md')

  $sb = New-Object Text.StringBuilder
  [void]$sb.AppendLine('---')
  [void]$sb.AppendLine('logNo: ' + $k)
  [void]$sb.AppendLine('날짜: ' + $m.date)
  [void]$sb.AppendLine('게시판: ' + $m.categoryPath)
  [void]$sb.AppendLine('원문: ' + $m.url)
  [void]$sb.AppendLine('글자수: ' + $text.Length)
  [void]$sb.AppendLine('이미지: ' + $imgFiles.Count)
  if ($tags.Count -gt 0) { [void]$sb.AppendLine('태그: ' + ($tags -join ', ')) }
  [void]$sb.AppendLine('---')
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine('# ' + $m.title)
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine($text)
  if ($imgFiles.Count -gt 0) {
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('## 이미지')
    [void]$sb.AppendLine('')
    foreach ($f in $imgFiles) { [void]$sb.AppendLine('![](../../이미지/' + $f + ')') }
  }
  if ($links.Count -gt 0) {
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine('## 본문 내 링크')
    [void]$sb.AppendLine('')
    foreach ($l in $links) { [void]$sb.AppendLine('- [' + $l.text + '](' + $l.href + ')') }
  }
  [IO.File]::WriteAllText($mdPath, $sb.ToString(), $utf8NoBom)

  $ro = New-Object psobject
  $ro | Add-Member NoteProperty logNo $k
  $ro | Add-Member NoteProperty date $m.date
  $ro | Add-Member NoteProperty title $m.title
  $ro | Add-Member NoteProperty categoryPath $m.categoryPath
  $ro | Add-Member NoteProperty categoryFolder $catFolder
  $ro | Add-Member NoteProperty url $m.url
  $ro | Add-Member NoteProperty chars $text.Length
  $ro | Add-Member NoteProperty images $imgFiles.Count
  $ro | Add-Member NoteProperty imageFiles $imgFiles
  $ro | Add-Member NoteProperty tags $tags
  $ro | Add-Member NoteProperty links $links
  $ro | Add-Member NoteProperty mdFile ($catFolder + '/' + $cand + '.md')
  [void]$records.Add($ro)
  $done = $done + 1

  if (($i % 5) -eq 0 -or $i -eq $order.Count) {
    Log ('body ' + $i + '/' + $order.Count + '  ok ' + $done + ' fail ' + $fail + '  img ' + $imgOK + ' (ng ' + $imgNG + ')')
  }
  if (($i % 25) -eq 0) { $records | ConvertTo-Json -Depth 6 | Out-File -FilePath $IdxF -Encoding UTF8 }
  Start-Sleep -Milliseconds 160
}

$records | ConvertTo-Json -Depth 6 | Out-File -FilePath $IdxF -Encoding UTF8
$sumChars = 0
foreach ($r in $records) { $sumChars = $sumChars + $r.chars }
Log ('=== DONE === posts ' + $done + ' (fail ' + $fail + ') / images ' + $imgOK + ' (fail ' + $imgNG + ') / chars ' + $sumChars)
Log ('output: ' + $Root)
Write-Host ''
Write-Host 'COMPLETE. You can close this window.' -ForegroundColor Green
Write-Host 'Tell Claude: collection finished.' -ForegroundColor Green
