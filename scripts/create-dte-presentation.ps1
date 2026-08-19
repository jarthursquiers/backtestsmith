param(
  [string]$OutputPath = (Join-Path (Split-Path -Parent $PSScriptRoot) 'OptionSmith-DTE-Profit-Target-Study.pptx'),
  [string]$PreviewDirectory = (Join-Path (Split-Path -Parent $PSScriptRoot) '.deck-preview')
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$logoPath = Join-Path $repoRoot 'os-logo.png'
if (-not (Test-Path -LiteralPath $logoPath)) {
  throw "Logo not found at $logoPath"
}

function RGB([string]$hex) {
  $clean = $hex.TrimStart('#')
  $r = [Convert]::ToInt32($clean.Substring(0, 2), 16)
  $g = [Convert]::ToInt32($clean.Substring(2, 2), 16)
  $b = [Convert]::ToInt32($clean.Substring(4, 2), 16)
  return $r + ($g * 256) + ($b * 65536)
}

function Pt([double]$inches) { return [single]($inches * 72) }

$C = @{
  Bg       = RGB '#090E16'
  Panel    = RGB '#121B2A'
  Panel2   = RGB '#172337'
  Panel3   = RGB '#0E1725'
  White    = RGB '#F4F7FB'
  Text     = RGB '#DFE8F2'
  Muted    = RGB '#8DA2B8'
  Faint    = RGB '#51677F'
  Grid     = RGB '#293A50'
  Gold     = RGB '#F4B942'
  GoldDark = RGB '#7C571A'
  Green    = RGB '#34D399'
  Green2   = RGB '#16A889'
  Cyan     = RGB '#43D7E8'
  Blue     = RGB '#60A5FA'
  Red      = RGB '#FB7185'
  Amber    = RGB '#F59E0B'
  Silver   = RGB '#CBD5E1'
}

function Add-Rect($slide, [double]$x, [double]$y, [double]$w, [double]$h, [int]$fill,
                  [double]$radius = 0, [int]$line = 0, [double]$transparency = 0, [double]$weight = 1) {
  $shapeType = if ($radius -gt 0) { 5 } else { 1 }
  $shape = $slide.Shapes.AddShape($shapeType, (Pt $x), (Pt $y), (Pt $w), (Pt $h))
  $shape.Fill.Solid()
  $shape.Fill.ForeColor.RGB = $fill
  $shape.Fill.Transparency = ($transparency / 100.0)
  if ($line -eq 0) {
    $shape.Line.Visible = 0
  } else {
    $shape.Line.Visible = -1
    $shape.Line.ForeColor.RGB = $line
    $shape.Line.Weight = $weight
  }
  return $shape
}

function Add-Circle($slide, [double]$x, [double]$y, [double]$d, [int]$fill, [double]$transparency = 0, [int]$line = 0) {
  $shape = $slide.Shapes.AddShape(9, (Pt $x), (Pt $y), (Pt $d), (Pt $d))
  $shape.Fill.Solid()
  $shape.Fill.ForeColor.RGB = $fill
  $shape.Fill.Transparency = ($transparency / 100.0)
  if ($line -eq 0) { $shape.Line.Visible = 0 } else { $shape.Line.ForeColor.RGB = $line; $shape.Line.Weight = 1.2 }
  return $shape
}

function Add-Line($slide, [double]$x1, [double]$y1, [double]$x2, [double]$y2, [int]$color,
                  [double]$weight = 1, [double]$transparency = 0, [bool]$dashed = $false) {
  $shape = $slide.Shapes.AddLine((Pt $x1), (Pt $y1), (Pt $x2), (Pt $y2))
  $shape.Line.ForeColor.RGB = $color
  $shape.Line.Weight = $weight
  $shape.Line.Transparency = ($transparency / 100.0)
  if ($dashed) { $shape.Line.DashStyle = 4 }
  return $shape
}

function Add-Text($slide, [string]$text, [double]$x, [double]$y, [double]$w, [double]$h,
                  [double]$size = 16, [int]$color = $C.Text, [bool]$bold = $false,
                  [int]$align = 1, [string]$font = 'Aptos', [double]$margin = 0.04) {
  $shape = $slide.Shapes.AddTextbox(1, (Pt $x), (Pt $y), (Pt $w), (Pt $h))
  $shape.Fill.Visible = 0
  $shape.Line.Visible = 0
  $tf = $shape.TextFrame
  $tf.WordWrap = -1
  $tf.AutoSize = 0
  $tf.MarginLeft = Pt $margin
  $tf.MarginRight = Pt $margin
  $tf.MarginTop = Pt $margin
  $tf.MarginBottom = Pt $margin
  $tf.VerticalAnchor = 3
  $tf.TextRange.Text = $text
  $tf.TextRange.Font.Name = $font
  $tf.TextRange.Font.Size = $size
  $tf.TextRange.Font.Bold = if ($bold) { -1 } else { 0 }
  $tf.TextRange.Font.Color.RGB = $color
  $tf.TextRange.ParagraphFormat.Alignment = $align
  return $shape
}

function Add-Pill($slide, [string]$text, [double]$x, [double]$y, [double]$w, [int]$fill, [int]$textColor) {
  Add-Rect $slide $x $y $w 0.30 $fill 0.12 0 0 | Out-Null
  Add-Text $slide $text $x $y $w 0.30 9 $textColor $true 2 | Out-Null
}

function Add-Logo($slide) {
  $picture = $slide.Shapes.AddPicture($logoPath, 0, -1, (Pt 12.34), (Pt 0.12), (Pt 0.78), (Pt 0.78))
  $picture.Line.Visible = 0
  return $picture
}

function Add-Canvas($presentation) {
  $slide = $presentation.Slides.Add($presentation.Slides.Count + 1, 12)
  Add-Rect $slide 0 0 13.333 7.5 $C.Bg | Out-Null
  Add-Circle $slide 10.55 -1.35 4.0 $C.Gold 88 | Out-Null
  Add-Circle $slide -1.35 5.25 3.4 $C.Green 92 | Out-Null
  Add-Line $slide 0.45 0.18 11.95 0.18 $C.Grid 0.7 30 | Out-Null
  Add-Logo $slide | Out-Null
  return $slide
}

function Add-Header($slide, [string]$kicker, [string]$title, [string]$subtitle, [int]$slideNumber) {
  Add-Text $slide $kicker 0.55 0.18 3.7 0.28 9 $C.Gold $true | Out-Null
  Add-Text $slide $title 0.55 0.52 11.4 0.55 26 $C.White $true | Out-Null
  Add-Text $slide $subtitle 0.57 1.06 11.0 0.38 10.5 $C.Muted $false | Out-Null
  Add-Pill $slide ("0$slideNumber / 05") 11.45 0.98 0.68 $C.Panel2 $C.Muted
}

function Add-Footer($slide, [string]$note, [bool]$targetFootnote = $false) {
  Add-Line $slide 0.55 7.10 12.78 7.10 $C.Grid 0.7 25 | Out-Null
  Add-Text $slide $note 0.57 7.14 8.7 0.20 7.2 $C.Faint $false | Out-Null
  if ($targetFootnote) {
    Add-Text $slide '* +300% is path-derived using the engine''s threshold-fill and $0.05 exit-slippage rules.' 7.55 7.14 5.20 0.20 7.0 $C.Gold $false 3 | Out-Null
  } else {
    Add-Text $slide 'OPTION  SMITH  |  CRAFT YOUR TRADING EDGE' 9.35 7.14 3.40 0.20 7.0 $C.Faint $true 3 | Out-Null
  }
}

function Money([double]$value) {
  $sign = if ($value -lt 0) { '-' } else { '' }
  return ('{0}${1:N0}' -f $sign, [Math]::Abs($value))
}

function Heat-Color([double]$value) {
  if ($value -ge 5000) { return $C.Green2 }
  if ($value -ge 4000) { return $C.GoldDark }
  if ($value -ge 3000) { return (RGB '#284967') }
  if ($value -ge 2200) { return (RGB '#2B3547') }
  return (RGB '#432738')
}

$allDteData = @(
  [pscustomobject]@{ Dte=7;  Entries=33; P150=1397.50; P200=1697.50; P300=2592.50; Ev150=42.35; Ev200=51.44; Ev300=78.56; Pf150=3.58; Pf200=3.51; Pf300=4.38; Dd150=-190.00; Dd200=-202.50; Dd300=-307.50; Win150=78.8; Win200=69.7; Win300=63.6; Hold150=73.5; Hold200=94.8; Hold300=107.0 },
  [pscustomobject]@{ Dte=11; Entries=33; P150=1535.00; P200=1935.00; P300=2155.00; Ev150=46.52; Ev200=58.64; Ev300=65.30; Pf150=6.20; Pf200=6.03; Pf300=4.34; Dd150=-145.00; Dd200=-205.00; Dd300=-350.00; Win150=90.9; Win200=84.8; Win300=66.7; Hold150=84.1; Hold200=97.0; Hold300=147.6 },
  [pscustomobject]@{ Dte=15; Entries=33; P150=1150.00; P200=1550.00; P300=2615.00; Ev150=34.85; Ev200=46.97; Ev300=79.24; Pf150=3.95; Pf200=4.48; Pf300=6.88; Dd150=-390.00; Dd200=-445.00; Dd300=-445.00; Win150=84.8; Win200=81.8; Win300=81.8; Hold150=110.1; Hold200=121.6; Hold300=126.6 },
  [pscustomobject]@{ Dte=19; Entries=33; P150=1132.50; P200=1465.00; P300=1890.00; Ev150=34.32; Ev200=44.39; Ev300=57.27; Pf150=5.12; Pf200=5.31; Pf300=4.94; Dd150=-120.00; Dd200=-120.00; Dd300=-215.00; Win150=87.9; Win200=81.8; Win300=72.7; Hold150=114.0; Hold200=140.2; Hold300=184.2 },
  [pscustomobject]@{ Dte=23; Entries=33; P150=1515.00; P200=1430.00; P300=1920.00; Ev150=45.91; Ev200=43.33; Ev300=58.18; Pf150=$null; Pf200=7.50; Pf300=6.91; Dd150=0.00; Dd200=-90.00; Dd300=-90.00; Win150=100.0; Win200=90.9; Win300=84.8; Hold150=108.8; Hold200=159.7; Hold300=199.5 }
)

$target15 = @(
  [pscustomobject]@{ Target=150; Pnl=1150.00; EV=34.85; Hit=84.8; Hold=110.1; DD=-390.00; PF=3.95 },
  [pscustomobject]@{ Target=200; Pnl=1550.00; EV=46.97; Hit=81.8; Hold=121.6; DD=-445.00; PF=4.48 },
  [pscustomobject]@{ Target=300; Pnl=2615.00; EV=79.24; Hit=81.8; Hold=126.6; DD=-445.00; PF=6.88 }
)

$widthData = @(
  [pscustomobject]@{ Width=20; P150=4005.00; P200=5935.00; Pf200=3.17; Dd200=-945.00; Debit=67 },
  [pscustomobject]@{ Width=25; P150=5735.00; P200=6560.00; Pf200=2.41; Dd200=-1870.00; Debit=97 },
  [pscustomobject]@{ Width=30; P150=6792.50; P200=5517.50; Pf200=1.71; Dd200=-2815.00; Debit=135 },
  [pscustomobject]@{ Width=35; P150=4893.75; P200=5250.00; Pf200=1.49; Dd200=-3397.50; Debit=174 },
  [pscustomobject]@{ Width=40; P150=3388.75; P200=2467.50; Pf200=1.17; Dd200=-4742.50; Debit=215 },
  [pscustomobject]@{ Width=45; P150=2827.50; P200=745.00; Pf200=1.04; Dd200=-6210.00; Debit=258 },
  [pscustomobject]@{ Width=50; P150=1506.25; P200=2867.50; Pf200=1.14; Dd200=-6320.00; Debit=303 }
)

$powerPoint = $null
$presentation = $null
try {
  $powerPoint = New-Object -ComObject PowerPoint.Application
  $powerPoint.Visible = -1
  $presentation = $powerPoint.Presentations.Add()
  $presentation.PageSetup.SlideWidth = Pt 13.333
  $presentation.PageSetup.SlideHeight = Pt 7.5

  # -------------------------------------------------------------------------
  # Slide 1 - five-DTE recommendation overview
  # -------------------------------------------------------------------------
  $s = Add-Canvas $presentation
  Add-Header $s 'ALL-DTE MATCHED ANALYSIS' '15 DTE +300% IS THE BEST OVERALL TRADE' '7 / 11 / 15 / 19 / 23 DTE  |  same 33 market sessions  |  20-point wings' 1

  Add-Rect $s 0.60 1.55 3.54 5.12 $C.Panel 0.12 $C.Gold 0 1.2 | Out-Null
  Add-Pill $s 'PRIMARY TRADE' 0.88 1.82 1.18 $C.GoldDark $C.Gold
  Add-Text $s '15 DTE' 0.86 2.28 2.40 0.55 30 $C.White $true | Out-Null
  Add-Text $s '20-wide butterfly' 0.88 2.82 2.70 0.33 14 $C.Text $true | Out-Null
  Add-Text $s 'Take profit at +300%' 0.88 3.22 2.92 0.38 17 $C.Gold $true | Out-Null
  Add-Line $s 0.88 3.78 3.86 3.78 $C.Grid 0.9 10 | Out-Null
  Add-Text $s '$79.24' 0.88 3.97 1.50 0.49 23 $C.Green $true | Out-Null
  Add-Text $s 'EV per trade' 2.28 4.09 1.16 0.24 8.7 $C.Muted $false | Out-Null
  Add-Text $s '$2,615' 0.88 4.56 1.50 0.49 23 $C.Gold $true | Out-Null
  Add-Text $s 'matched total P/L' 2.28 4.68 1.30 0.24 8.7 $C.Muted $false | Out-Null
  Add-Rect $s 0.87 5.29 2.98 1.02 $C.Panel3 0.08 0 0 | Out-Null
  Add-Text $s 'WHY THIS ONE' 1.04 5.42 1.30 0.22 8.3 $C.Gold $true | Out-Null
  Add-Text $s 'Highest EV, 81.8% hit rate, PF 6.88; only 20 hours slower than 7 DTE.' 1.04 5.67 2.62 0.52 9.6 $C.Text $true | Out-Null

  Add-Text $s 'EV PER TRADE  |  33 IDENTICAL SESSIONS' 4.47 1.65 5.20 0.24 9 $C.Muted $true | Out-Null
  $x0=5.04; $cellW=1.48; $cellH=1.06
  for($i=0;$i -lt $allDteData.Count;$i++){
    $x=$x0+$i*$cellW
    Add-Text $s ("{0} DTE" -f $allDteData[$i].Dte) $x 1.97 1.28 0.32 10.5 $C.White $true 2 | Out-Null
  }
  $targets=@(150,200,300)
  for($r=0;$r -lt $targets.Count;$r++){
    $target=$targets[$r]; $y=2.43+$r*$cellH
    Add-Text $s ("+{0}%" -f $target) 4.14 $y 0.70 0.82 9.6 $C.Gold $true 3 | Out-Null
    for($i=0;$i -lt $allDteData.Count;$i++){
      $d=$allDteData[$i]; $x=$x0+$i*$cellW
      $pnl=[double]$d.("P$target"); $ev=[double]$d.("Ev$target")
      $isWinner=($target -eq 150 -and $d.Dte -eq 11)-or($target -eq 200 -and $d.Dte -eq 11)-or($target -eq 300 -and $d.Dte -eq 15)
      $fill=if($isWinner){$C.GoldDark}elseif($d.Dte -eq 15){(RGB '#1A3A39')}else{(RGB '#213550')}
      Add-Rect $s $x $y 1.27 0.82 $fill 0.07 $C.Grid 0 | Out-Null
      Add-Text $s ("`$$('{0:N2}' -f $ev)") $x ($y+0.08) 1.27 0.31 11.3 $C.White $true 2 | Out-Null
      Add-Text $s (Money $pnl) $x ($y+0.47) 1.27 0.19 7.4 $C.Silver $false 2 | Out-Null
    }
  }
  Add-Rect $s ($x0+2*$cellW-0.04) (2.43+2*$cellH-0.05) 1.35 0.92 $C.Gold 0.08 $C.Gold 100 2.2 | Out-Null
  Add-Pill $s 'THE READ' 5.02 5.88 0.88 $C.GoldDark $C.Gold
  Add-Text $s '11 DTE wins at +150 / +200.  15 DTE wins at +300.' 6.10 5.84 5.55 0.34 11.2 $C.White $true | Out-Null
  Add-Text $s 'The return edge peaks at 15 DTE, then declines at 19 and 23 DTE.' 6.10 6.19 5.55 0.24 9 $C.Muted $false | Out-Null
  Add-Footer $s 'Matched window: 2025-08-18 to 2026-07-10  |  EMA 9  |  3-minute carry limit  |  $0.05 slippage' $false

  # -------------------------------------------------------------------------
  # Slide 2 - all DTEs by target
  # -------------------------------------------------------------------------
  $s = Add-Canvas $presentation
  Add-Header $s 'DTE COMPARISON' 'ALL FIVE DTEs ON THE SAME MARKET DATES' 'Expected value by profit target  |  every point represents the same 33 sessions' 2

  Add-Rect $s 0.60 1.55 8.52 5.18 $C.Panel 0.12 $C.Grid 3 | Out-Null
  Add-Text $s 'EV PER TRADE BY DTE' 0.88 1.78 3.15 0.24 9 $C.Muted $true | Out-Null
  $xPoints=@(1.42,3.02,4.62,6.22,7.82); $plotTop=2.27; $plotBottom=5.72; $plotMax=90.0
  for($g=0;$g -le 3;$g++){
    $value=$g*30; $gy=$plotBottom-($value/$plotMax)*($plotBottom-$plotTop)
    Add-Line $s 1.10 $gy 8.70 $gy $C.Grid 0.65 30 | Out-Null
    Add-Text $s ("`$$value") 0.66 ($gy-0.11) 0.40 0.20 7.3 $C.Faint $false 3 | Out-Null
  }
  $series=@(
    @{Target=150;Color=$C.Cyan;Field='Ev150'},
    @{Target=200;Color=$C.Green;Field='Ev200'},
    @{Target=300;Color=$C.Gold;Field='Ev300'}
  )
  foreach($ser in $series){
    $pts=@()
    for($i=0;$i -lt $allDteData.Count;$i++){
      $value=[double]$allDteData[$i].($ser.Field); $py=$plotBottom-($value/$plotMax)*($plotBottom-$plotTop)
      $pts+=,@($xPoints[$i],$py)
      if($i -gt 0){Add-Line $s $pts[$i-1][0] $pts[$i-1][1] $pts[$i][0] $pts[$i][1] $ser.Color 2.7 0 | Out-Null}
      Add-Circle $s ($xPoints[$i]-0.10) ($py-0.10) 0.20 $ser.Color 0 $C.White | Out-Null
    }
  }
  for($i=0;$i -lt $allDteData.Count;$i++){
    Add-Text $s ("{0} DTE" -f $allDteData[$i].Dte) ($xPoints[$i]-0.42) 5.90 0.84 0.25 10 $C.White $true 2 | Out-Null
  }
  $legendX=1.22
  foreach($ser in $series){
    Add-Line $s $legendX 6.47 ($legendX+0.28) 6.47 $ser.Color 2.7 | Out-Null
    Add-Text $s ("+{0}%" -f $ser.Target) ($legendX+0.35) 6.35 0.72 0.23 8.3 $C.Muted $true | Out-Null
    $legendX+=1.28
  }

  Add-Text $s 'WINNERS BY TARGET' 9.50 1.67 2.55 0.24 9 $C.Gold $true | Out-Null
  $winnerCards=@(
    @{Y=2.08;C=$C.Cyan;Tag='+150%';Dte='11 DTE';EV='$46.52';Body='90.9% hit  |  PF 6.20  |  84h hold'},
    @{Y=3.26;C=$C.Green;Tag='+200%';Dte='11 DTE';EV='$58.64';Body='84.8% hit  |  PF 6.03  |  97h hold'},
    @{Y=4.44;C=$C.Gold;Tag='+300%';Dte='15 DTE';EV='$79.24';Body='81.8% hit  |  PF 6.88  |  127h hold'}
  )
  foreach($card in $winnerCards){
    Add-Rect $s 9.40 $card.Y 3.26 0.98 $C.Panel 0.08 $C.Grid 2 | Out-Null
    Add-Pill $s $card.Tag 9.61 ($card.Y+0.17) 0.70 $C.Panel2 $card.C
    Add-Text $s $card.Dte 10.51 ($card.Y+0.10) 0.90 0.25 10.5 $C.White $true | Out-Null
    Add-Text $s $card.EV 11.48 ($card.Y+0.08) 0.86 0.30 14 $card.C $true 3 | Out-Null
    Add-Text $s $card.Body 10.51 ($card.Y+0.48) 1.83 0.23 7.7 $C.Muted $false | Out-Null
  }
  Add-Rect $s 9.40 5.78 3.26 0.66 $C.Panel3 0.08 $C.Gold 0 1.0 | Out-Null
  Add-Text $s 'Best overall: 15 DTE +300%.' 9.62 5.94 2.82 0.28 10.5 $C.Gold $true 2 | Out-Null
  Add-Footer $s 'Five-way matched population: 33 sessions where every tested DTE produced the same 20-wide entry' $false

  # -------------------------------------------------------------------------
  # Slide 3 - recommended target ladder
  # -------------------------------------------------------------------------
  $s = Add-Canvas $presentation
  Add-Header $s 'EXIT MANAGEMENT' 'LET THE 15-DTE TRADE REACH +300%' 'The larger target added substantial EV with almost no extra average holding time' 3

  Add-Rect $s 0.60 1.55 7.86 5.18 $C.Panel 0.12 $C.Grid 3 | Out-Null
  Add-Text $s '15 DTE TOTAL P/L BY PROFIT TARGET' 0.88 1.78 3.55 0.24 9 $C.Muted $true | Out-Null
  $barBase=5.80; $barMaxH=3.38; $barMax=3000.0; $barX=@(1.48,3.72,5.96)
  for($g=0;$g -le 3;$g++){
    $gy=$barBase-$g*$barMaxH/3
    Add-Line $s 1.02 $gy 8.05 $gy $C.Grid 0.65 30 | Out-Null
    Add-Text $s (Money ($g*1000)) 0.54 ($gy-0.11) 0.45 0.20 7.3 $C.Faint $false 3 | Out-Null
  }
  for($i=0;$i -lt $target15.Count;$i++){
    $t=$target15[$i]; $h=$barMaxH*$t.Pnl/$barMax; $accent=if($t.Target -eq 300){$C.Gold}elseif($t.Target -eq 200){$C.Green}else{$C.Cyan}
    Add-Rect $s $barX[$i] ($barBase-$h) 1.10 $h $accent 0.06 0 4 | Out-Null
    Add-Text $s (Money $t.Pnl) ($barX[$i]-0.10) ($barBase-$h-0.34) 1.30 0.25 12 $C.White $true 2 | Out-Null
    Add-Text $s ("+{0}%" -f $t.Target) ($barX[$i]-0.10) 5.93 1.30 0.28 11 $C.White $true 2 | Out-Null
    Add-Pill $s ("EV {0}" -f (Money $t.EV)) ($barX[$i]-0.04) 6.28 1.18 $C.Panel2 $accent
  }

  Add-Text $s 'THE TRADE-OFF' 8.88 1.67 2.40 0.24 9 $C.Gold $true | Out-Null
  for($i=0;$i -lt $target15.Count;$i++){
    $t=$target15[$i]; $y=2.05+$i*1.25; $accent=if($t.Target -eq 300){$C.Gold}elseif($t.Target -eq 200){$C.Green}else{$C.Cyan}
    Add-Rect $s 8.82 $y 3.84 1.03 $C.Panel 0.10 $C.Grid 3 | Out-Null
    Add-Rect $s 8.82 $y 0.08 1.03 $accent 0.04 0 0 | Out-Null
    Add-Text $s ("+{0}%" -f $t.Target) 9.08 ($y+0.10) 0.86 0.30 14 $accent $true | Out-Null
    Add-Text $s ("EV {0}" -f (Money $t.EV)) 10.34 ($y+0.09) 1.94 0.32 15 $C.White $true 3 | Out-Null
    Add-Text $s ("{0}% hit  |  {1:N0}h hold  |  DD {2}" -f $t.Hit,$t.Hold,(Money $t.DD)) 9.08 ($y+0.51) 3.10 0.23 8.3 $C.Muted $false | Out-Null
    Add-Pill $s ("PF {0:N2}" -f $t.PF) 11.73 ($y+0.72) 0.66 $C.Panel2 $accent
  }
  Add-Rect $s 8.82 5.90 3.84 0.66 $C.Panel3 0.08 $C.Gold 0 1.2 | Out-Null
  Add-Text $s '+300% adds $1,065 and $32.27 EV vs +200%.' 9.02 6.04 3.44 0.34 10 $C.Gold $true 2 | Out-Null
  Add-Footer $s 'At 15 DTE, +300% kept the same 81.8% hit rate as +200% and added only about 5 average hours.' $false

  # -------------------------------------------------------------------------
  # Slide 4 - completed width sweep
  # -------------------------------------------------------------------------
  $s = Add-Canvas $presentation
  Add-Header $s 'STRUCTURE SELECTION' 'USE 20-POINT WINGS FOR THE PRIMARY TRADE' 'Completed sweep: 20 wide delivered the best profit-factor and drawdown efficiency' 4

  Add-Rect $s 0.60 1.55 8.30 5.25 $C.Panel 0.12 $C.Grid 3 | Out-Null
  Add-Text $s 'TOTAL P/L BY WING WIDTH' 0.88 1.76 3.2 0.24 9 $C.Muted $true | Out-Null
  $widthX = @(1.34,2.42,3.50,4.58,5.66,6.74,7.82)
  $widthTop = 2.22; $widthBottom = 5.78; $widthMax = 7500.0
  for($g=0;$g -le 3;$g++){
    $value=$g*2500
    $gy=$widthBottom-(($value/$widthMax)*($widthBottom-$widthTop))
    Add-Line $s 1.08 $gy 8.45 $gy $C.Grid 0.65 30 | Out-Null
    Add-Text $s (Money $value) 0.57 ($gy-0.11) 0.48 0.20 7.5 $C.Faint $false 3 | Out-Null
  }
  $widthSeries=@(
    @{Name='+150%';Color=$C.Cyan;Field='P150'},
    @{Name='+200%';Color=$C.Green;Field='P200'}
  )
  foreach($ser in $widthSeries){
    $pts=@()
    for($i=0;$i -lt $widthData.Count;$i++){
      $value=[double]$widthData[$i].($ser.Field)
      $py=$widthBottom-(($value/$widthMax)*($widthBottom-$widthTop))
      $pts+=,@($widthX[$i],$py)
      if($i -gt 0){Add-Line $s $pts[$i-1][0] $pts[$i-1][1] $pts[$i][0] $pts[$i][1] $ser.Color 2.5 0 | Out-Null}
      Add-Circle $s ($widthX[$i]-0.085) ($py-0.085) 0.17 $ser.Color 0 $C.White | Out-Null
    }
  }
  for($i=0;$i -lt $widthData.Count;$i++){
    Add-Text $s ("{0}" -f $widthData[$i].Width) ($widthX[$i]-0.30) 5.94 0.60 0.25 9.5 $C.White $true 2 | Out-Null
  }
  Add-Text $s 'WING WIDTH (SPX POINTS)' 3.20 6.28 3.0 0.22 8 $C.Muted $true 2 | Out-Null
  Add-Line $s 1.12 6.57 1.42 6.57 $C.Cyan 2.5 | Out-Null
  Add-Text $s '+150%' 1.50 6.45 0.65 0.22 8.5 $C.Muted $true | Out-Null
  Add-Line $s 2.37 6.57 2.67 6.57 $C.Green 2.5 | Out-Null
  Add-Text $s '+200%' 2.75 6.45 0.65 0.22 8.5 $C.Muted $true | Out-Null
  Add-Pill $s '+150% PEAK  $6,793' 3.34 2.25 1.48 $C.Panel2 $C.Cyan
  Add-Pill $s '+200% PEAK  $6,560' 1.56 2.63 1.48 $C.Panel2 $C.Green

  Add-Text $s 'WHY 20 WIDE' 9.28 1.66 2.8 0.24 9 $C.Gold $true | Out-Null
  $widthCards=@(
    @{Y=2.08;C=$C.Gold;Tag='20 WIDE';Title='PRIMARY CHOICE';Body='Best risk efficiency: PF 3.17  |  DD -$945  |  $67 average debit'},
    @{Y=3.17;C=$C.Cyan;Tag='25 WIDE';Title='BEST +200% P/L';Body='$6,560 total  |  PF 2.41  |  DD -$1,870'},
    @{Y=4.26;C=$C.Gold;Tag='30 WIDE';Title='BEST +150% P/L';Body='$6,793 total  |  PF 2.16  |  DD -$1,926'},
    @{Y=5.35;C=$C.Red;Tag='40-50';Title='EDGE FADES';Body='Profit factor approaches 1 while drawdown expands'}
  )
  foreach($card in $widthCards){
    Add-Rect $s 9.18 $card.Y 3.48 0.89 $C.Panel 0.08 $C.Grid 2 | Out-Null
    Add-Pill $s $card.Tag 9.38 ($card.Y+0.17) 0.76 $C.Panel2 $card.C
    Add-Text $s $card.Title 10.28 ($card.Y+0.11) 2.05 0.24 9.4 $C.White $true | Out-Null
    Add-Text $s $card.Body 10.28 ($card.Y+0.45) 2.05 0.24 7.8 $C.Muted $false | Out-Null
  }
  Add-Footer $s 'Width evidence: 11 DTE, same 108 dates across 20 / 25 / 30 / 35 / 40 / 45 / 50-point wings' $false

  # -------------------------------------------------------------------------
  # Slide 5 - trading recommendation
  # -------------------------------------------------------------------------
  $s = Add-Canvas $presentation
  Add-Header $s 'CONCLUSION' 'THE RECOMMENDED TRADE' 'A specific implementation based on the matched DTE study and completed wing-width sweep' 5

  Add-Rect $s 0.60 1.55 12.13 1.28 $C.Panel3 0.12 $C.Gold 0 1.0 | Out-Null
  Add-Text $s 'TESTED DTE' 0.88 1.75 1.02 0.22 8.5 $C.Gold $true | Out-Null
  $dteLabels=@('7','11','15','19','23')
  for($i=0;$i -lt $dteLabels.Count;$i++){Add-Pill $s $dteLabels[$i] (1.98+$i*0.50) 1.69 0.40 $C.Panel2 $C.White}
  Add-Line $s 5.12 1.76 5.12 2.55 $C.Grid 0.8 10 | Out-Null
  Add-Text $s 'TESTED WINGS' 5.38 1.75 1.18 0.22 8.5 $C.Gold $true | Out-Null
  $wingLabels=@('20','25','30','35','40','45','50')
  for($i=0;$i -lt $wingLabels.Count;$i++){Add-Pill $s $wingLabels[$i] (6.67+$i*0.55) 1.69 0.42 $C.Panel2 $C.White}
  Add-Line $s 10.72 1.76 10.72 2.55 $C.Grid 0.8 10 | Out-Null
  Add-Text $s 'TARGETS' 11.03 1.75 0.78 0.22 8.5 $C.Gold $true | Out-Null
  Add-Text $s '150 / 200 / 300%' 10.98 2.10 1.36 0.28 11 $C.White $true 2 | Out-Null

  $insights=@(
    @{X=0.60;Accent=$C.Gold;Tag='DTE';Title='ENTER AROUND 15 DTE';Kpi='15';Body='At +300%, 15 DTE delivered the highest five-way matched EV with an 81.8% hit rate.'},
    @{X=4.72;Accent=$C.Green;Tag='EXIT';Title='SET THE TARGET AT +300%';Kpi='+300%';Body='Highest matched EV and total P/L; only five average hours longer than the +200% exit.'},
    @{X=8.84;Accent=$C.Cyan;Tag='WIDTH';Title='KEEP THE WINGS AT 20';Kpi='20 WIDE';Body='The width sweep gave 20 wide the best profit factor and drawdown efficiency.'}
  )
  foreach($card in $insights){
    Add-Rect $s $card.X 3.10 3.89 2.18 $C.Panel 0.12 $C.Grid 3 | Out-Null
    Add-Pill $s $card.Tag ($card.X+0.28) 3.34 0.70 $C.Panel2 $card.Accent
    Add-Text $s $card.Kpi ($card.X+2.15) 3.27 1.40 0.42 21 $card.Accent $true 3 | Out-Null
    Add-Text $s $card.Title ($card.X+0.28) 3.86 3.30 0.30 12 $C.White $true | Out-Null
    Add-Text $s $card.Body ($card.X+0.28) 4.32 3.24 0.56 9.3 $C.Muted $false | Out-Null
  }

  Add-Rect $s 0.60 5.57 12.13 1.12 $C.Panel3 0.12 $C.Gold 0 1.1 | Out-Null
  Add-Pill $s 'EXECUTE' 0.88 5.82 0.82 $C.GoldDark $C.Gold
  Add-Text $s 'PRIMARY' 2.02 5.72 0.80 0.20 8 $C.Muted $true | Out-Null
  Add-Text $s '15 DTE  |  20-wide  |  +300%' 2.00 6.02 2.82 0.32 14 $C.Gold $true | Out-Null
  Add-Line $s 5.12 5.78 5.12 6.47 $C.Grid 0.8 10 | Out-Null
  Add-Text $s 'SHORTER-HOLD ALTERNATIVE' 5.50 5.72 2.18 0.20 8 $C.Muted $true | Out-Null
  Add-Text $s '7 DTE  |  20-wide  |  +300%' 5.48 6.02 2.84 0.32 14 $C.Blue $true | Out-Null
  Add-Line $s 8.73 5.78 8.73 6.47 $C.Grid 0.8 10 | Out-Null
  Add-Text $s 'ENTRY RULE' 9.11 5.72 0.94 0.20 8 $C.Muted $true | Out-Null
  Add-Text $s 'EMA 9  |  09:35  |  15m window' 9.09 6.02 3.00 0.32 13 $C.Cyan $true | Out-Null
  Add-Footer $s 'Research conclusion, not trading advice  |  all DTE conclusions use the same 33 entry dates and pricing assumptions' $false

  $outDir = Split-Path -Parent $OutputPath
  if (-not (Test-Path -LiteralPath $outDir)) { New-Item -ItemType Directory -Path $outDir -Force | Out-Null }
  $presentation.SaveAs($OutputPath, 24)

  if (-not (Test-Path -LiteralPath $PreviewDirectory)) {
    New-Item -ItemType Directory -Path $PreviewDirectory -Force | Out-Null
  }
  foreach ($slide in $presentation.Slides) {
    $previewPath = Join-Path $PreviewDirectory ("slide-{0}.png" -f $slide.SlideIndex)
    $slide.Export($previewPath, 'PNG', 1600, 900)
  }

  Write-Output "Created: $OutputPath"
  Write-Output "Preview: $PreviewDirectory"
}
finally {
  if ($presentation -ne $null) { $presentation.Close() }
  if ($powerPoint -ne $null) { $powerPoint.Quit() }
  if ($presentation -ne $null) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($presentation) }
  if ($powerPoint -ne $null) { [void][Runtime.InteropServices.Marshal]::ReleaseComObject($powerPoint) }
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}
