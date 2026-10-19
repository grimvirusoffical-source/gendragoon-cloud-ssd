#!/usr/bin/env bash
# Builds libgendragoon for this machine's platform into Source/ThirdParty/GenDragoonLib/lib/<Platform>/, where
# GenDragoon.Build.cs picks it up. Needs Go 1.22+ and a C compiler. Run it once per platform you ship.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
go_sdk="$(cd "$here/../../../../go" && pwd)"
case "$(uname -s)" in
  Linux)  platform=Linux; name=libgendragoon.so ;;
  Darwin) platform=Mac;   name=libgendragoon.dylib ;;
  MINGW*|MSYS*|CYGWIN*) platform=Win64; name=gendragoon.dll ;;
  *) echo "unsupported platform $(uname -s)" >&2; exit 1 ;;
esac
out="$here/../Source/ThirdParty/GenDragoonLib/lib/$platform"
mkdir -p "$out"
(cd "$go_sdk" && CGO_ENABLED=1 go build -trimpath -buildmode=c-shared -o "$out/$name" ./cabi)
rm -f "$out/${name%.*}.h"   # the stable header is include/gendragoon.h
echo "built $out/$name"
