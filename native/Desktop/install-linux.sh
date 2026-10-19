#!/bin/sh
# Install the checked-out companion for the current user; no sudo, pip or secrets.
set -eu
if [ "$(uname -s)" != "Linux" ]; then
  printf '%s\n' 'Use the native GenDragoon installer for your platform.' >&2
  exit 1
fi
python3 -c 'import sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"'
gd_source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gd_install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gendragoon/companion"
gd_bin_dir="$HOME/.local/bin"
mkdir -p "$gd_install_dir" "$gd_bin_dir"
if [ -L "$gd_install_dir" ] || [ -L "$gd_bin_dir/gendragoon" ]; then
  printf '%s\n' 'Installation target is a link; inspect it before replacing it.' >&2
  exit 1
fi
install -m 600 "$gd_source_dir/gendragoon_desktop.py" "$gd_install_dir/gendragoon_desktop.py.new"
python3 -m py_compile "$gd_install_dir/gendragoon_desktop.py.new"
mv "$gd_install_dir/gendragoon_desktop.py.new" "$gd_install_dir/gendragoon_desktop.py"
python3 - "$gd_install_dir/gendragoon_desktop.py" "$gd_bin_dir/gendragoon" <<'PY'
import pathlib,shlex,sys
target=pathlib.Path(sys.argv[2])
target.write_text('#!/bin/sh\nexec python3 '+shlex.quote(sys.argv[1])+' "$@"\n')
target.chmod(0o700)
PY
"$gd_bin_dir/gendragoon" capabilities
printf '%s\n' "Installed: $gd_bin_dir/gendragoon"
printf '%s\n' 'If this command is not on your PATH, use its full path above.'
