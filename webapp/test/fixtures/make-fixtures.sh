#!/usr/bin/env bash
# Regenerates the synthetic test fixtures. Needs ImageMagick 7 (`magick`) and a TrueType font.
# Usage: ./make-fixtures.sh [path/to/font.ttf]
# All content is generated: pangrams and flat colours. Never put real scans here.
set -euo pipefail
cd "$(dirname "$0")"
FONT=${1:-/System/Library/Fonts/Supplemental/Arial.ttf}
LINE="The quick brown fox jumps over the lazy dog. Pack my box with five dozen liquor jugs. How vexingly quick daft zebras jump. Sphinx of black quartz, judge my vow. "
TEXT=""
for _ in 1 2 3 4 5 6; do TEXT="$TEXT$LINE"; done

# Upright text page at 150 dpi, then the fixture is that page turned upside down.
magick -density 150 -size 1000x -background white -fill black -font "$FONT" -pointsize 11 caption:"$TEXT" \
  -bordercolor white -border 60 -colorspace Gray -depth 8 PNG8:upright-text.png
magick upright-text.png -rotate 180 -colorspace Gray -depth 8 PNG8:upside-down-text.png

# Small PNMs as the scanner service sends them.
magick -size 64x48 xc:"gray(50%)" -colorspace Gray -depth 8 pgm:gray.pgm
magick -size 64x48 xc:white -depth 8 ppm:white.ppm
magick -size 64x48 pattern:checkerboard -threshold 50% -monochrome pbm:lineart.pbm
