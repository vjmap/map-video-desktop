#!/usr/bin/env bash
# 在 macOS 上从源码编 LGPL 版 ffmpeg / ffprobe（docs/map-video/116 §7.3）：静态链接 libvpx、libopus、dav1d（BSD）、zimg（WTFPL），H.264 用系统的 VideoToolbox，
# 不带 --enable-gpl / --enable-nonfree（免费商用）。源码版本和 sha256 在 binaries.json 的 ffmpeg.mac-sources。
# 输出 staging/ffmpeg-<target>/{bin/ffmpeg,bin/ffprobe,LICENSE}，scripts/stage-resources.mjs 从这里取。
#   bash scripts/build-ffmpeg-macos.sh mac-arm64    # 在 Apple 芯片的 Mac 上（GitHub Actions：macos-15）
#   bash scripts/build-ffmpeg-macos.sh mac-x64      # 在 Intel Mac 上（GitHub Actions：macos-15-intel）
# zimg 给 zscale（HDR 素材转 SDR，出片核抽帧时用），dav1d 给 AV1 素材解码；和服务器、Windows 版的能力对齐。
# 要 nasm（x64 的 libvpx / dav1d 汇编）、pkg-config、autotools（zimg）、meson + ninja（dav1d）：brew install nasm pkgconf autoconf automake libtool meson ninja
set -euo pipefail

target="${1:?用法：build-ffmpeg-macos.sh mac-arm64|mac-x64}"
case "$target" in
  mac-arm64) [ "$(uname -m)" = "arm64" ] || { echo "要在 Apple 芯片的 Mac 上编 mac-arm64"; exit 1; }; vpx_target="arm64-darwin20-gcc" ;;
  mac-x64)   [ "$(uname -m)" = "x86_64" ] || { echo "要在 Intel Mac 上编 mac-x64"; exit 1; }; vpx_target="x86_64-darwin20-gcc" ;;
  *) echo "不认识的目标 $target"; exit 1 ;;
esac

root="$(cd "$(dirname "$0")/.." && pwd)"
work="$root/staging/.ffbuild-$target"
deps="$work/deps"
out="$root/staging/ffmpeg-$target"
rm -rf "$work" "$out"
mkdir -p "$work/src" "$deps" "$out/bin"
export MACOSX_DEPLOYMENT_TARGET=12.0
export PKG_CONFIG_PATH="$deps/lib/pkgconfig"
jobs="$(sysctl -n hw.ncpu)"

pin() { node -e "const s=require('$root/binaries.json').ffmpeg['mac-sources']['$1'];process.stdout.write(s['$2'])"; }
fetch() {
  local name="$1" url sha file
  url="$(pin "$name" url)"; sha="$(pin "$name" sha256)"
  file="$work/src/$(basename "$url")"
  curl -fL --retry 3 -o "$file" "$url"
  echo "$sha  $file" | shasum -a 256 -c - >/dev/null || { echo "$name 源码校验和对不上"; exit 1; }
  mkdir -p "$work/src/$name"
  tar -xf "$file" -C "$work/src/$name" --strip-components 1
}

echo "== 取源码"
fetch libvpx
fetch opus
fetch zimg
fetch dav1d
fetch ffmpeg

echo "== libvpx（${vpx_target}）"
(cd "$work/src/libvpx" && ./configure --prefix="$deps" --target="$vpx_target" --disable-shared --enable-static --enable-pic \
  --disable-examples --disable-tools --disable-docs --disable-unit-tests --enable-vp8 --enable-vp9 && make -j"$jobs" && make install)

echo "== opus"
(cd "$work/src/opus" && ./configure --prefix="$deps" --disable-shared --enable-static --with-pic --disable-doc --disable-extra-programs && make -j"$jobs" && make install)

echo "== zimg"
# Homebrew 的 libtool 命令叫 glibtoolize（避开 Apple 自带的 libtool），autoreconf 按 LIBTOOLIZE 找
command -v libtoolize >/dev/null || export LIBTOOLIZE=glibtoolize
# 静态库是 C++ 的：pkg-config 里要带上 macOS 的 C++ 运行时（缺省写的 -lstdc++ 新版 macOS 已经没有）
(cd "$work/src/zimg" && ./autogen.sh && ./configure --prefix="$deps" --disable-shared --enable-static --with-pic STL_LIBS="-lc++" && make -j"$jobs" && make install)

echo "== dav1d"
(cd "$work/src/dav1d" && meson setup build --prefix="$deps" --libdir=lib --default-library=static --buildtype=release \
  -Denable_tools=false -Denable_tests=false -Denable_examples=false -Denable_docs=false && ninja -C build install)

echo "== ffmpeg"
# --disable-autodetect：不让 configure 顺手链上 Homebrew 里的库（别人的机器上没有，还可能是 GPL）；要的系统组件逐个打开
(cd "$work/src/ffmpeg" && ./configure --prefix="$work/ffmpeg-install" \
  --disable-autodetect --enable-pthreads --enable-videotoolbox --enable-audiotoolbox --enable-zlib --enable-bzlib --enable-iconv \
  --enable-libvpx --enable-libopus --enable-libzimg --enable-libdav1d \
  --disable-shared --enable-static --disable-debug --disable-doc --disable-ffplay \
  --pkg-config-flags=--static --extra-cflags="-I$deps/include -mmacosx-version-min=12.0" --extra-ldflags="-L$deps/lib -mmacosx-version-min=12.0" \
  --extra-libs="-liconv" \
  && make -j"$jobs" && make install)

cp "$work/ffmpeg-install/bin/ffmpeg" "$work/ffmpeg-install/bin/ffprobe" "$out/bin/"
cp "$work/src/ffmpeg/COPYING.LGPLv2.1" "$out/LICENSE"

echo "== 检查"
conf="$("$out/bin/ffmpeg" -hide_banner -buildconf 2>&1)"
if echo "$conf" | grep -Eq -- "--enable-(gpl|nonfree)"; then echo "编出来的是 GPL / nonfree 构建，不能分发"; exit 1; fi
for b in ffmpeg ffprobe; do
  # 只能链系统库：/usr/lib、/System（Homebrew 的 /opt/homebrew、/usr/local 在用户机器上没有）
  bad="$(otool -L "$out/bin/$b" | tail -n +2 | awk '{print $1}' | grep -Ev '^(/usr/lib/|/System/)' || true)"
  if [ -n "$bad" ]; then echo "$b 链了系统以外的库：$bad"; exit 1; fi
done
"$out/bin/ffmpeg" -hide_banner -encoders | grep -q h264_videotoolbox || { echo "没编进 VideoToolbox"; exit 1; }
"$out/bin/ffmpeg" -hide_banner -encoders | grep -q libvpx-vp9 || { echo "没编进 libvpx"; exit 1; }
"$out/bin/ffmpeg" -hide_banner -filters | grep -qw zscale || { echo "没编进 zimg（zscale）"; exit 1; }
"$out/bin/ffmpeg" -hide_banner -decoders | grep -qw libdav1d || { echo "没编进 dav1d"; exit 1; }
"$out/bin/ffmpeg" -hide_banner -loglevel error -f lavfi -i color=size=320x240:rate=1:duration=1 -frames:v 1 -an -c:v h264_videotoolbox -b:v 1M -allow_sw 1 -f null - || { echo "VideoToolbox 编码试不通"; exit 1; }
rm -rf "$work"
echo "== 好了：$out/bin（$(du -sh "$out/bin" | cut -f1)）"
