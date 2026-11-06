$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

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
    $glowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(40, $accent))

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
    $font = New-Object System.Drawing.Font("Malgun Gothic", 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
    $g.DrawString($text, $font, $white, (New-Object System.Drawing.RectangleF(6, 94, 132, 36)), $sf)
}

function Build-IconSet([string]$outDir, [string]$brandType, [string]$brandLabel, [string]$brandColor) {
    New-Item -ItemType Directory -Force -Path $outDir | Out-Null
    $g = $null; $acc = $null

    # 1. category.png
    $bmp = New-BaseBitmap $brandColor ([ref]$g) ([ref]$acc)
    $pen = New-Object System.Drawing.Pen($acc, 5.5)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    if ($brandType -eq "agy") {
        # Orbit ring + 4-point Gemini diamond star
        $g.TranslateTransform(72, 52)
        $g.RotateTransform(-24)
        $g.DrawEllipse($pen, -32, -13, 64, 26)
        $g.ResetTransform()
        $star = @(
            (New-Object System.Drawing.PointF(72, 24)),
            (New-Object System.Drawing.PointF(80, 44)),
            (New-Object System.Drawing.PointF(100, 52)),
            (New-Object System.Drawing.PointF(80, 60)),
            (New-Object System.Drawing.PointF(72, 80)),
            (New-Object System.Drawing.PointF(64, 60)),
            (New-Object System.Drawing.PointF(44, 52)),
            (New-Object System.Drawing.PointF(64, 44))
        )
        $g.FillPolygon((New-Object System.Drawing.SolidBrush($acc)), $star)
    } else {
        # Codex Hexagonal Prism + core
        $hex = New-Object System.Drawing.PointF[] 6
        for ($i = 0; $i -lt 6; $i++) {
            $a = ($i * 60 - 90) * [Math]::PI / 180.0
            $hex[$i] = New-Object System.Drawing.PointF((72 + [float]([Math]::Cos($a) * 28)), (52 + [float]([Math]::Sin($a) * 28)))
        }
        $g.DrawPolygon($pen, $hex)
        $g.FillEllipse((New-Object System.Drawing.SolidBrush($acc)), 62, 42, 20, 20)
    }
    Draw-BottomLabel $g $brandLabel
    $bmp.Save((Join-Path $outDir "category.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()

    # 2. icon-status.png
    $bmp = New-BaseBitmap $brandColor ([ref]$g) ([ref]$acc)
    $pen = New-Object System.Drawing.Pen($acc, 6)
    $g.DrawEllipse($pen, 44, 24, 56, 56)
    $g.FillEllipse((New-Object System.Drawing.SolidBrush($acc)), 62, 42, 20, 20)
    Draw-BottomLabel $g "상태"
    $bmp.Save((Join-Path $outDir "icon-status.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()

    # 3. icon-approve.png
    $bmp = New-BaseBitmap "#34D399" ([ref]$g) ([ref]$acc)
    $pen = New-Object System.Drawing.Pen($acc, 8)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawLines($pen, @(
        (New-Object System.Drawing.PointF(48, 54)),
        (New-Object System.Drawing.PointF(65, 71)),
        (New-Object System.Drawing.PointF(98, 37))
    ))
    Draw-BottomLabel $g "승인"
    $bmp.Save((Join-Path $outDir "icon-approve.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()

    # 4. icon-model.png
    $bmp = New-BaseBitmap "#C084FC" ([ref]$g) ([ref]$acc)
    $pen = New-Object System.Drawing.Pen($acc, 5)
    $chip = New-RoundedRectPath 48 28 48 48 10
    $g.DrawPath($pen, $chip)
    $g.FillRectangle((New-Object System.Drawing.SolidBrush($acc)), 60, 40, 24, 24)
    foreach ($off in @(58, 72, 86)) {
        $g.DrawLine($pen, $off, 18, $off, 28)
        $g.DrawLine($pen, $off, 76, $off, 86)
        $g.DrawLine($pen, 38, ($off - 20), 48, ($off - 20))
        $g.DrawLine($pen, 96, ($off - 20), 106, ($off - 20))
    }
    Draw-BottomLabel $g "모델"
    $bmp.Save((Join-Path $outDir "icon-model.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()

    # 5. icon-mode.png
    $bmp = New-BaseBitmap "#38BDF8" ([ref]$g) ([ref]$acc)
    $bolt = @(
        (New-Object System.Drawing.PointF(78, 20)),
        (New-Object System.Drawing.PointF(50, 54)),
        (New-Object System.Drawing.PointF(70, 54)),
        (New-Object System.Drawing.PointF(65, 84)),
        (New-Object System.Drawing.PointF(94, 48)),
        (New-Object System.Drawing.PointF(74, 48))
    )
    $g.FillPolygon((New-Object System.Drawing.SolidBrush($acc)), $bolt)
    Draw-BottomLabel $g "설정"
    $bmp.Save((Join-Path $outDir "icon-mode.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()

    # 6. icon-cmd.png
    $bmp = New-BaseBitmap "#FBBF24" ([ref]$g) ([ref]$acc)
    $pen = New-Object System.Drawing.Pen($acc, 7)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawLines($pen, @(
        (New-Object System.Drawing.PointF(48, 36)),
        (New-Object System.Drawing.PointF(68, 52)),
        (New-Object System.Drawing.PointF(48, 68))
    ))
    $g.DrawLine($pen, 76, 68, 98, 68)
    Draw-BottomLabel $g "명령"
    $bmp.Save((Join-Path $outDir "icon-cmd.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()

    # 7. icon-util.png
    $bmp = New-BaseBitmap "#F472B6" ([ref]$g) ([ref]$acc)
    $pen = New-Object System.Drawing.Pen($acc, 5.5)
    $pen.StartCap = [System.Drawing.Drawing2D.LineCap]::Round
    $pen.EndCap = [System.Drawing.Drawing2D.LineCap]::Round
    $cap = New-RoundedRectPath 62 22 20 34 10
    $g.FillPath((New-Object System.Drawing.SolidBrush($acc)), $cap)
    $g.DrawArc($pen, 52, 32, 40, 34, 0, 180)
    $g.DrawLine($pen, 72, 66, 72, 80)
    $g.DrawLine($pen, 58, 80, 86, 80)
    Draw-BottomLabel $g "도구"
    $bmp.Save((Join-Path $outDir "icon-util.png"), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
}

Build-IconSet (Join-Path $PSScriptRoot "plugins\com.vibecoding.antigravity.sdPlugin\static") "agy" "AGY" "#60A5FA"
Build-IconSet (Join-Path $PSScriptRoot "plugins\com.vibecoding.codex.sdPlugin\static") "codex" "CODEX" "#34D399"
Write-Host "Generated static vector icons for both Antigravity and Codex plugins!"
