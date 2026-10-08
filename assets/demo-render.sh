#!/bin/sh
# Renders assets/demo.gif: a 2.5 s title card (assets/social-preview.png) followed by the recorded demo.
# Needs vhs and ffmpeg. Run from the repository root.
set -e
vhs assets/demo.tape
ffmpeg -v error -y \
  -loop 1 -t 2.5 -i assets/social-preview.png -i assets/demo-body.mp4 \
  -filter_complex "[0]scale=1400:-2,pad=1400:820:0:(oh-ih)/2:color=0x1e1e2e,setsar=1,fps=12[t];[1]fps=12,scale=1400:820,setsar=1[b];[t][b]concat=n=2:v=1:a=0,split[x][y];[x]palettegen=max_colors=128[p];[y][p]paletteuse=dither=bayer:bayer_scale=4" \
  assets/demo.gif
rm -f assets/demo-body.mp4
