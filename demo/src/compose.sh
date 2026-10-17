#!/usr/bin/env bash
# 合成 out/demo.mp4
#   视频：frames/%05d.png（30fps，共 4200 帧 / 140.0s）→ libx264 yuv420p crf18
#   音频：lavfi 程序生成 A 大三和弦低频 pad（110/164.81/220/277.18 Hz），
#         amix 后 volume=0.05，2s 淡入、结尾 3s 淡出，时长 140s → AAC 96k
#   海报：frames/04185.png（t=139.5s）→ out/poster.png
set -euo pipefail
cd "$(dirname "$0")/.."

FPS=30
DUR=140
# amix 默认按输入路数（4）归一化，等效增益约 1/4；
# 故 volume=0.35 对应「四路 sine 相加后约 0.05」的听感，pad 峰值落在约 -28dB（storyboard §3）
PAD_VOL=0.35
FADE_IN=2
FADE_OUT=3
POSTER_FRAME=04185

mkdir -p out

ffmpeg -y -hide_banner -stats \
  -framerate "$FPS" -i frames/%05d.png \
  -f lavfi -i "sine=frequency=110:duration=${DUR}:sample_rate=48000" \
  -f lavfi -i "sine=frequency=164.81:duration=${DUR}:sample_rate=48000" \
  -f lavfi -i "sine=frequency=220:duration=${DUR}:sample_rate=48000" \
  -f lavfi -i "sine=frequency=277.18:duration=${DUR}:sample_rate=48000" \
  -filter_complex "[1:a][2:a][3:a][4:a]amix=inputs=4:duration=longest,volume=${PAD_VOL},afade=t=in:st=0:d=${FADE_IN},afade=t=out:st=$((DUR-FADE_OUT)):d=${FADE_OUT}[pad]" \
  -map 0:v -map "[pad]" \
  -c:v libx264 -pix_fmt yuv420p -crf 18 -r "$FPS" \
  -c:a aac -b:a 96k \
  -shortest \
  out/demo.mp4

cp "frames/${POSTER_FRAME}.png" out/poster.png
echo "OK -> out/demo.mp4 + out/poster.png"
