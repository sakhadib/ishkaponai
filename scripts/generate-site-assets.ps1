# Generates the site's image assets from the app icon, so the mark is never
# duplicated by hand and cannot drift from `build/icon.png`.
#
#   docs/og.png      1200 x 630, the Open Graph / Twitter card. This is what a link
#                    looks like when shared on WhatsApp or Facebook, which for this
#                    project's audience is how it will mostly spread.
#   docs/favicon.png 512 x 512, the mark on its own.
#
# Both are committed. Re-run this only when the logo changes.
#
# ## Running it on Windows
#
# PowerShell's execution policy blocks `.\generate-site-assets.ps1` on most
# machines, which is the same reason `npm` needs to be typed as `npm.cmd` here.
# Either of these works:
#
#   powershell -ExecutionPolicy Bypass -File scripts\generate-site-assets.ps1
#
# or, from the repository root:
#
#   Get-Content scripts\generate-site-assets.ps1 -Raw | Invoke-Expression
#
# The second form is why every non-ASCII character below is written as a codepoint
# rather than a literal: a piped script is decoded as ANSI, and a typed "·" arrives
# on the card as "Â·". That is a real bug this file already had once.
#
# The alternative is to delete the two PNGs and never regenerate them, which is
# fine until the logo changes and then the site is advertising a mark the app no
# longer ships.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# $PSScriptRoot is only populated when this runs as a file. Piped into
# Invoke-Expression it is an empty string, so fall back to the working directory -
# which both of the documented invocations set to the repository root anyway.
$repoRoot = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$source = Join-Path $repoRoot 'build\icon.png'
$docs = Join-Path $repoRoot 'docs'

if (-not (Test-Path $source)) {
  throw "No logo at $source. The site assets are generated from build/icon.png; fix the path before rerunning."
}

$logo = [System.Drawing.Image]::FromFile($source)

# --- Open Graph card: 1200 x 630 is what every platform crops to -------------
$W = 1200
$H = 630
$card = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($card)
$g.SmoothingMode = 'AntiAlias'
$g.InterpolationMode = 'HighQualityBicubic'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.Color]::FromArgb(255, 250, 250, 252))

# A faint wash of the logo's own gradient, so the card is not a flat slab.
$wash = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
  (New-Object System.Drawing.Rectangle(0, 0, $W, $H)),
  [System.Drawing.Color]::FromArgb(28, 34, 211, 238),
  [System.Drawing.Color]::FromArgb(28, 168, 85, 247),
  35.0
)
$g.FillRectangle($wash, 0, 0, $W, $H)

$markSize = 300
$g.DrawImage($logo, (New-Object System.Drawing.Rectangle(
  [int](($W - $markSize) / 2), 108, $markSize, $markSize)))

function Write-Line($text, $size, $y, $bold, $colour) {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $font = New-Object System.Drawing.Font('Segoe UI', $size, $style, [System.Drawing.GraphicsUnit]::Pixel)
  $format = New-Object System.Drawing.StringFormat
  $format.Alignment = [System.Drawing.StringAlignment]::Center
  $box = New-Object System.Drawing.RectangleF(0, $y, $W, ($size * 1.6))
  $pen = New-Object System.Drawing.SolidBrush($colour)
  $g.DrawString($text, $font, $pen, $box, $format)
  $pen.Dispose()
  $format.Dispose()
  $font.Dispose()
}

Write-Line 'ISHKAPON AI' 62 430 $true ([System.Drawing.Color]::FromArgb(255, 15, 23, 42))

# U+00B7 MIDDLE DOT, as a codepoint. See the header.
$dot = [string][char]0x00B7
Write-Line ('Physics  ' + $dot + '  Chemistry  ' + $dot + '  Mathematics') 26 512 $false ([System.Drawing.Color]::FromArgb(255, 71, 85, 105))

$card.Save((Join-Path $docs 'og.png'), [System.Drawing.Imaging.ImageFormat]::Png)

# --- favicon: the mark on its own, square ---------------------------------
$icon = New-Object System.Drawing.Bitmap(512, 512)
$gi = [System.Drawing.Graphics]::FromImage($icon)
$gi.SmoothingMode = 'AntiAlias'
$gi.InterpolationMode = 'HighQualityBicubic'
$gi.Clear([System.Drawing.Color]::Transparent)
$gi.DrawImage($logo, 0, 0, 512, 512)
$icon.Save((Join-Path $docs 'favicon.png'), [System.Drawing.Imaging.ImageFormat]::Png)

$gi.Dispose()
$icon.Dispose()
$wash.Dispose()
$g.Dispose()
$card.Dispose()
$logo.Dispose()

Write-Output 'Wrote docs/og.png (1200x630) and docs/favicon.png (512x512)'
