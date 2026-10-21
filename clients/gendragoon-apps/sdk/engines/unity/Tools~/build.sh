#!/usr/bin/env bash
# Builds the .NET Standard 2.1 SDK assembly into Runtime/Plugins, where the package's asmdef expects it.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
DOTNET="${DOTNET:-$(command -v dotnet || echo "$HOME/.dotnet/dotnet")}"
"$DOTNET" build -c Release -f netstandard2.1 "$here/../../csharp/src/Gendragoon.Sdk" >/dev/null
mkdir -p "$here/Runtime/Plugins"
cp "$here/../../csharp/src/Gendragoon.Sdk/bin/Release/netstandard2.1/Gendragoon.Sdk.dll" "$here/Runtime/Plugins/"
cp "$here/../../csharp/src/Gendragoon.Sdk/bin/Release/netstandard2.1/Gendragoon.Sdk.xml" "$here/Runtime/Plugins/" 2>/dev/null || true
echo "Runtime/Plugins/Gendragoon.Sdk.dll"
