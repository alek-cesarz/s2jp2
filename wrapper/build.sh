#!/usr/bin/env bash
# Rebuilds stex-jp2.wasm + stex-jp2.mjs from wrapper/jp2.cpp.
# Assumes emsdk is at ~/emsdk and OpenJPEG 2.5.3 is cloned next to this repo
# at ../openjpeg with build-wasm/bin/libopenjp2.a already produced.
set -euo pipefail
source "$HOME/emsdk/emsdk_env.sh"

cd "$(dirname "$0")"
em++ -O3 -std=c++17 \
  -I ../openjpeg/src/lib/openjp2 \
  -I ../openjpeg/build-wasm/src/lib/openjp2 \
  -lembind \
  -s MODULARIZE=1 -s EXPORT_NAME=createStexJp2 \
  -s ENVIRONMENT=node,web -s EXPORT_ES6=1 \
  -s ALLOW_MEMORY_GROWTH=1 -s INITIAL_MEMORY=64MB -s MAXIMUM_MEMORY=2GB \
  jp2.cpp ../openjpeg/build-wasm/bin/libopenjp2.a \
  -o ../src/decoder/stex-jp2.mjs
