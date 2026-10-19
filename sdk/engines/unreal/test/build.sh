#!/usr/bin/env bash
# Builds libgendragoon from sdk/go/cabi and the C test next to it (build/ is ignored by git).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
out="$here/build"
mkdir -p "$out"
(cd "$here/../../../go" && go build -buildmode=c-shared -o "$out/libgendragoon.so" ./cabi)
cc -std=c11 -Wall -Wextra -Werror -I"$here/../GenDragoon/Source/ThirdParty/GenDragoonLib/include" "$here/cabi_test.c" \
  -L"$out" -lgendragoon -Wl,-rpath,'$ORIGIN' -o "$out/cabi_test"
