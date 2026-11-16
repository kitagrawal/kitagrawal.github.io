#!/bin/sh
# Rebuilds og-image.png (1200x630 share card) and apple-touch-icon.png (180x180)
# at the repo root from og.html and icon.html. Needs Google Chrome and a network
# connection (og.html loads the brand fonts from Google Fonts).
set -e
cd "$(dirname "$0")"
C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
"$C" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --virtual-time-budget=6000 --window-size=1200,630 --screenshot=../../og-image.png "file://$PWD/og.html"
"$C" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=180,180 --screenshot=../../apple-touch-icon.png "file://$PWD/icon.html"
