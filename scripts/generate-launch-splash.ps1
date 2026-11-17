param(
  [string]$OutputPath = (Join-Path $PSScriptRoot '..\build\caps-launch-splash.bmp')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$projectRoot = Split-Path -Parent $PSScriptRoot
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$outputDirectory = Split-Path -Parent $resolvedOutput

[System.IO.Directory]::CreateDirectory($outputDirectory) | Out-Null

$bitmap = New-Object System.Drawing.Bitmap 360, 220, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$icon = $null
$titleFont = $null
$statusFont = $null
$backgroundBrush = $null
$panelBrush = $null
$borderPen = $null
$glowBrush = $null
$titleBrush = $null
$mutedBrush = $null
$dotBrush = $null
$dotMutedBrush = $null
$format = $null
$panelPath = $null

try {
  $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

  $backgroundBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(15, 17, 21))
  $graphics.FillRectangle($backgroundBrush, 0, 0, 360, 220)

  $panelPath = New-Object System.Drawing.Drawing2D.GraphicsPath
  $panelPath.AddArc(10, 10, 36, 36, 180, 90)
  $panelPath.AddArc(314, 10, 36, 36, 270, 90)
  $panelPath.AddArc(314, 174, 36, 36, 0, 90)
  $panelPath.AddArc(10, 174, 36, 36, 90, 90)
  $panelPath.CloseFigure()

  $panelBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(23, 25, 31))
  $borderPen = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(48, 51, 61)), 1
  $graphics.FillPath($panelBrush, $panelPath)
  $graphics.DrawPath($borderPen, $panelPath)

  # The portable extractor supports a bitmap; match the animated Electron splash.
  $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(167, 139, 250))
  $barHeights = @(18, 25, 40, 22, 32, 35, 16, 28, 44, 18, 22)
  for ($index = 0; $index -lt $barHeights.Count; $index++) {
    $barHeight = $barHeights[$index]
    $barX = 133 + ($index * 9)
    $barY = 70 - ($barHeight / 2)
    $graphics.FillRectangle($dotBrush, $barX, ($barY + 2), 4, ($barHeight - 4))
    $graphics.FillEllipse($dotBrush, $barX, $barY, 4, 4)
    $graphics.FillEllipse($dotBrush, $barX, ($barY + $barHeight - 4), 4, 4)
  }

  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $format.LineAlignment = [System.Drawing.StringAlignment]::Center

  $titleFont = New-Object System.Drawing.Font 'Segoe UI', 23, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
  $statusFont = New-Object System.Drawing.Font 'Segoe UI', 13, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  $titleBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 255, 255))
  $mutedBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(167, 173, 186))

  $graphics.DrawString('Caps', $titleFont, $titleBrush, (New-Object System.Drawing.RectangleF 16, 105, 328, 30), $format)
  $graphics.DrawString('Getting things ready...', $statusFont, $mutedBrush, (New-Object System.Drawing.RectangleF 16, 139, 328, 24), $format)
  $taglineFont = New-Object System.Drawing.Font 'Segoe UI', 9, ([System.Drawing.FontStyle]::Regular), ([System.Drawing.GraphicsUnit]::Pixel)
  try {
    $graphics.DrawString('YOUR AUDIO. YOUR WORKSPACE.', $taglineFont, $dotBrush, (New-Object System.Drawing.RectangleF 16, 174, 328, 22), $format)
  } finally { $taglineFont.Dispose() }

  $bitmap.Save($resolvedOutput, [System.Drawing.Imaging.ImageFormat]::Bmp)
}
finally {
  foreach ($resource in @(
    $graphics, $icon, $titleFont, $statusFont, $backgroundBrush, $panelBrush,
    $borderPen, $glowBrush, $titleBrush, $mutedBrush, $dotBrush, $dotMutedBrush,
    $format, $panelPath, $bitmap
  )) {
    if ($null -ne $resource) { $resource.Dispose() }
  }
}

Write-Output $resolvedOutput
