$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

$outDir = Join-Path $PSScriptRoot "plugins\com.vibecoding.claudecode.sdPlugin\static"
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundedRectPath([float]$x, [float]$y, [float]$w, [float]$h, [float]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($x, $y, $d, $d, 180, 90)
    $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
    $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
    $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

function New-BaseBitmap([string]$accentHex, [ref]$gOut, [ref]$accentOut) {
    $bmp = New-Object System.Drawing.Bitmap(144, 144, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $bgColor = [System.Drawing.ColorTranslator]::FromHtml("#0B0B0C")
    $accent = [System.Drawing.ColorTranslator]::FromHtml($accentHex)
    $borderPen = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(240, $accent), 5)
    $bgBrush = New-Object System.Drawing.SolidBrush($bgColor)
    $glowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(38, $accent))

    $card = New-RoundedRectPath 5 5 134 134 26
    $g.FillPath($bgBrush, $card)
    $g.FillEllipse($glowBrush, 24, 14, 96, 84)
    $g.DrawPath($borderPen, $card)

    $gOut.Value = $g
    $accentOut.Value = $accent
    return $bmp
}

function Draw-BottomLabel($g, [string]$text) {
    $sf = New-Object System.Drawing.StringFormat
    $sf.Alignment = [System.Drawing.StringAlignment]::Center
    $sf.LineAlignment = [System.Drawing.StringAlignment]::Center
    $font = New-Object System.Drawing.Font("Malgun Gothic", 21, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.DrawString($text, $font, $white, (New-Object System.Drawing.RectangleF(8, 94, 128, 36)), $sf)
}

# 1. category.png (Claude 8-spoke starburst)
$g = $null; $acc = $null
$bmp = New-BaseBitmap "#FF8B66" ([ref]$g) ([ref]$acc)
$pen = New-Object System.Drawing.Pen($acc, 6.5)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
for ($i = 0; $i -lt 8; $i++) {
    $ang = $i * [Math]::PI / 4.0
    $x1 = 72 + [float]([Math]::Cos($ang) * 10)
    $y1 = 54 + [float]([Math]::Sin($ang) * 10)
    $x2 = 72 + [float]([Math]::Cos($ang) * 28)
    $y2 = 54 + [float]([Math]::Sin($ang) * 28)
    $g.DrawLine($pen, $x1, $y1, $x2, $y2)
}
Draw-BottomLabel $g "CLAUDE"
$bmp.Save((Join-Path $outDir "category.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# 2. icon-status.png (Pulse ring + dot)
$bmp = New-BaseBitmap "#38BDF8" ([ref]$g) ([ref]$acc)
$pen = New-Object System.Drawing.Pen($acc, 6)
$g.DrawEllipse($pen, 44, 26, 56, 56)
$g.FillEllipse((New-Object System.Drawing.SolidBrush($acc)), 62, 44, 20, 20)
Draw-BottomLabel $g "상태"
$bmp.Save((Join-Path $outDir "icon-status.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# 3. icon-approve.png (Bold Checkmark)
$bmp = New-BaseBitmap "#34D399" ([ref]$g) ([ref]$acc)
$pen = New-Object System.Drawing.Pen($acc, 8)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$pts = @(
    (New-Object System.Drawing.PointF(48, 55)),
    (New-Object System.Drawing.PointF(65, 72)),
    (New-Object System.Drawing.PointF(98, 38))
)
$g.DrawLines($pen, $pts)
Draw-BottomLabel $g "승인"
$bmp.Save((Join-Path $outDir "icon-approve.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# 4. icon-model.png (AI Chip)
$bmp = New-BaseBitmap "#C084FC" ([ref]$g) ([ref]$acc)
$pen = New-Object System.Drawing.Pen($acc, 5)
$chip = New-RoundedRectPath 48 30 48 48 10
$g.DrawPath($pen, $chip)
$g.FillRectangle((New-Object System.Drawing.SolidBrush($acc)), 60, 42, 24, 24)
foreach ($off in @(58, 72, 86)) {
    $g.DrawLine($pen, $off, 20, $off, 30)
    $g.DrawLine($pen, $off, 78, $off, 88)
    $g.DrawLine($pen, 38, ($off - 18), 48, ($off - 18))
    $g.DrawLine($pen, 96, ($off - 18), 106, ($off - 18))
}
Draw-BottomLabel $g "모델"
$bmp.Save((Join-Path $outDir "icon-model.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# 5. icon-mode.png (Lightning Bolt)
$bmp = New-BaseBitmap "#38BDF8" ([ref]$g) ([ref]$acc)
$bolt = @(
    (New-Object System.Drawing.PointF(78, 22)),
    (New-Object System.Drawing.PointF(50, 56)),
    (New-Object System.Drawing.PointF(70, 56)),
    (New-Object System.Drawing.PointF(65, 86)),
    (New-Object System.Drawing.PointF(94, 50)),
    (New-Object System.Drawing.PointF(74, 50))
)
$g.FillPolygon((New-Object System.Drawing.SolidBrush($acc)), $bolt)
Draw-BottomLabel $g "모드"
$bmp.Save((Join-Path $outDir "icon-mode.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# 6. icon-cmd.png (Terminal >_)
$bmp = New-BaseBitmap "#FBBF24" ([ref]$g) ([ref]$acc)
$pen = New-Object System.Drawing.Pen($acc, 7)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
$chev = @(
    (New-Object System.Drawing.PointF(48, 38)),
    (New-Object System.Drawing.PointF(68, 54)),
    (New-Object System.Drawing.PointF(48, 70))
)
$g.DrawLines($pen, $chev)
$g.DrawLine($pen, 76, 70, 98, 70)
Draw-BottomLabel $g "명령"
$bmp.Save((Join-Path $outDir "icon-cmd.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

# 7. icon-util.png (Studio Mic)
$bmp = New-BaseBitmap "#F472B6" ([ref]$g) ([ref]$acc)
$pen = New-Object System.Drawing.Pen($acc, 5.5)
$pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
$pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
$cap = New-RoundedRectPath 62 24 20 34 10
$g.FillPath((New-Object System.Drawing.SolidBrush($acc)), $cap)
$g.DrawArc($pen, 52, 34, 40, 34, 0, 180)
$g.DrawLine($pen, 72, 68, 72, 82)
$g.DrawLine($pen, 58, 82, 86, 82)
Draw-BottomLabel $g "도구"
$bmp.Save((Join-Path $outDir "icon-util.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()

Write-Host "Generated 7 pure vector PNG icons in $outDir"
