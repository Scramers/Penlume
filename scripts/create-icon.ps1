# Generate the Penlume P mark as a multi-size Windows icon without external tools.
Add-Type -AssemblyName System.Drawing
$taskRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$assetRoot = Join-Path $taskRoot 'assets'
[IO.Directory]::CreateDirectory($assetRoot) | Out-Null
$iconImages = @()
foreach ($iconSize in @(16, 24, 32, 48, 64, 128, 256)) {
  $bitmap = [Drawing.Bitmap]::new($iconSize, $iconSize, [Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [Drawing.Graphics]::FromImage($bitmap)
  $graphics.SmoothingMode = [Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $graphics.ScaleTransform(($iconSize / 256.0), ($iconSize / 256.0))
  $outline = [Drawing.Drawing2D.GraphicsPath]::new()
  $outline.AddArc(0, 0, 104, 104, 180, 90)
  $outline.AddArc(152, 0, 104, 104, 270, 90)
  $outline.AddArc(152, 152, 104, 104, 0, 90)
  $outline.AddArc(0, 152, 104, 104, 90, 90)
  $outline.CloseFigure()
  $background = [Drawing.SolidBrush]::new([Drawing.ColorTranslator]::FromHtml('#5965d9'))
  $graphics.FillPath($background, $outline)
  $letter = [Drawing.Drawing2D.GraphicsPath]::new([Drawing.Drawing2D.FillMode]::Alternate)
  $letter.AddLine(76, 60, 144, 60)
  $letter.AddBezier(144, 60, 176, 60, 194, 78, 194, 105)
  $letter.AddBezier(194, 105, 194, 132, 174, 149, 144, 149)
  $letter.AddLine(144, 149, 103, 149)
  $letter.AddLine(103, 149, 103, 198)
  $letter.AddLine(103, 198, 76, 198)
  $letter.CloseFigure()
  $letter.StartFigure()
  $letter.AddLine(103, 83, 103, 126)
  $letter.AddLine(103, 126, 142, 126)
  $letter.AddBezier(142, 126, 158, 126, 168, 119, 168, 105)
  $letter.AddBezier(168, 105, 168, 91, 158, 83, 142, 83)
  $letter.CloseFigure()
  $graphics.FillPath([Drawing.Brushes]::White, $letter)
  $graphics.FillEllipse([Drawing.Brushes]::White, 181, 173, 24, 24)
  $memory = [IO.MemoryStream]::new()
  $bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)
  $iconImages += @{ Size = $iconSize; Bytes = $memory.ToArray() }
  if ($iconSize -eq 256) { $bitmap.Save((Join-Path $assetRoot 'icon.png'), [Drawing.Imaging.ImageFormat]::Png) }
  $memory.Dispose(); $letter.Dispose(); $background.Dispose(); $outline.Dispose(); $graphics.Dispose(); $bitmap.Dispose()
}
$iconFile = [IO.File]::Create((Join-Path $assetRoot 'icon.ico'))
$writer = [IO.BinaryWriter]::new($iconFile)
try {
  $writer.Write([UInt16]0); $writer.Write([UInt16]1); $writer.Write([UInt16]$iconImages.Count)
  $imageOffset = 6 + 16 * $iconImages.Count
  foreach ($iconImage in $iconImages) {
    $dimension = if ($iconImage.Size -eq 256) { 0 } else { $iconImage.Size }
    $writer.Write([Byte]$dimension); $writer.Write([Byte]$dimension); $writer.Write([Byte]0); $writer.Write([Byte]0)
    $writer.Write([UInt16]1); $writer.Write([UInt16]32); $writer.Write([UInt32]$iconImage.Bytes.Length); $writer.Write([UInt32]$imageOffset)
    $imageOffset += $iconImage.Bytes.Length
  }
  foreach ($iconImage in $iconImages) { $writer.Write([Byte[]]$iconImage.Bytes) }
} finally { $writer.Dispose(); $iconFile.Dispose() }
