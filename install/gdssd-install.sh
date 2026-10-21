#!/usr/bin/env bash
set -euo pipefail
# Install with: bash gdssd-install.sh
# This bootstrap requires a trusted HTTPS release manifest and SHA-256 pin.
BASE="${GDSSD_RELEASE_BASE:-https://github.com/grimvirusoffical-source/gendragoon-cloud-ssd/releases/latest/download}"
case "$(uname -s)" in Darwin) os=macos;; Linux) os=linux;; *) echo 'Unsupported OS' >&2; exit 2;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) echo 'Unsupported CPU' >&2; exit 2;; esac
command -v curl >/dev/null && command -v python3 >/dev/null || { echo 'curl and python3 required' >&2; exit 2; }
work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
curl -fLsS --proto '=https' --tlsv1.2 "$BASE/gdssd-$os-$arch.sha256" -o "$work/checksum"
curl -fLsS --proto '=https' --tlsv1.2 "$BASE/gdssd-$os-$arch.tar.gz" -o "$work/package.tar.gz"
(cd "$work" && shasum -a 256 -c checksum)
# Tar extraction happens only after checksum verification; reject unsafe archive entries.
python3 - "$work/package.tar.gz" "$work/extract" <<'PY'
import pathlib,sys,tarfile
source,dest=pathlib.Path(sys.argv[1]),pathlib.Path(sys.argv[2]); dest.mkdir()
with tarfile.open(source,'r:gz') as tar:
 for member in tar.getmembers():
  path=pathlib.PurePosixPath(member.name)
  if path.is_absolute() or '..' in path.parts or member.issym() or member.islnk() or member.isdev():
   raise SystemExit('Unsafe archive member')
  if not (member.isfile() or member.isdir()): raise SystemExit('Unsupported archive member')
 tar.extractall(dest,filter='data')
PY
if [[ "$os" == macos ]]; then
  test -d "$work/extract/GenDragoon SSD.app" || { echo 'Missing signed macOS app' >&2; exit 3; }
  mkdir -p "$HOME/Applications" "$HOME/.local/bin"
  ditto "$work/extract/GenDragoon SSD.app" "$HOME/Applications/GenDragoon SSD.app"
else
  test -x "$work/extract/gdssd-app" || { echo 'Missing Linux executable' >&2; exit 3; }
  mkdir -p "$HOME/.local/share/gdssd" "$HOME/.local/bin"
  install -m 755 "$work/extract/gdssd-app" "$HOME/.local/share/gdssd/gdssd-app"
fi
cat > "$HOME/.local/bin/GDSSD" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
case "${1:-}" in
Install) echo "GenDragoon is installed. To update, rerun the verified bootstrap." ;;
Install-CloudCLI) echo "CloudCLI provisioning requires a configured live Red-XAI issuer; not yet available." >&2; exit 3 ;;
*) echo "Usage: GDSSD Install | GDSSD Install-CloudCLI" ;;
esac
EOF
chmod 755 "$HOME/.local/bin/GDSSD"
echo "Installed. Add $HOME/.local/bin to PATH. CloudCLI remains unavailable until Red-XAI deployment."
