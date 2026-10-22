# Render the native installer's brand panel from the existing app icon.
# No new runtime dependency; rebuild on Windows when the brand changes.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$buildDir = Join-Path $PSScriptRoot '../apps/desktop/build'
$bitmap = [Drawing.Bitmap]::new(328, 628, [Drawing.Imaging.PixelFormat]::Format24bppRgb)
$canvas = [Drawing.Graphics]::FromImage($bitmap)
$icon = [Drawing.Image]::FromFile((Join-Path $buildDir 'icon.png'))
$background = [Drawing.Drawing2D.LinearGradientBrush]::new([Drawing.Point]::new(0,0), [Drawing.Point]::new(328,628), [Drawing.Color]::FromArgb(36,36,39), [Drawing.Color]::FromArgb(17,17,19))
$ink = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(244,244,245))
$muted = [Drawing.SolidBrush]::new([Drawing.Color]::FromArgb(156,156,164))
$line = [Drawing.Pen]::new([Drawing.Color]::FromArgb(62,62,68), 1)
$title = [Drawing.Font]::new('Segoe UI', 27, [Drawing.FontStyle]::Bold, [Drawing.GraphicsUnit]::Pixel)
$caption = [Drawing.Font]::new('Segoe UI', 17, [Drawing.FontStyle]::Regular, [Drawing.GraphicsUnit]::Pixel)
try {
  $canvas.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $canvas.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $canvas.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $canvas.FillRectangle($background, 0, 0, 328, 628)
  $canvas.DrawImage($icon, 40, 68, 112, 112)
  $canvas.DrawString('mc-agent', $title, $ink, 48, 200)
  $canvas.DrawLine($line, 48, 535, 280, 535)
  $canvas.DrawString('WINDOWS', $caption, $muted, 48, 555)
  $bitmap.Save((Join-Path $buildDir 'installerSidebar.bmp'), [Drawing.Imaging.ImageFormat]::Bmp)
} finally {
  $caption.Dispose(); $title.Dispose(); $line.Dispose(); $muted.Dispose(); $ink.Dispose()
  $background.Dispose(); $icon.Dispose(); $canvas.Dispose(); $bitmap.Dispose()
}
