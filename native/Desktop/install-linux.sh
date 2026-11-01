#!/bin/sh
# Install only GenDragoon's current-user runtime and private virtual environment.
set -eu
if [ "$(uname -s)" != "Linux" ]; then
  printf '%s\n' 'Use the native GenDragoon installer for your platform.' >&2
  exit 1
fi
python3 -c 'import sys,tkinter; assert sys.version_info[:2] == (3, 13), "Python 3.13 and tkinter are required"'
gd_source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
gd_install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gendragoon/companion"
gd_bin_dir="$HOME/.local/bin"
mkdir -p "$gd_install_dir" "$gd_bin_dir"
if [ -L "$gd_install_dir" ] || [ -L "$gd_bin_dir/gendragoon" ]; then
  printf '%s\n' 'Installation target is a link; inspect it before replacing it.' >&2
  exit 1
fi
if [ -L "$gd_install_dir/venv" ]; then
  printf '%s\n' 'The private environment is linked; inspect it before installing.' >&2
  exit 1
fi
python3 -B "$gd_source_dir/gendragoon_gui.py" --check-idle
python3 -B "$gd_source_dir/stage_runtime.py" --destination "$gd_install_dir"
python3 -m venv "$gd_install_dir/venv"
"$gd_install_dir/venv/bin/python" -B -m pip install --disable-pip-version-check --only-binary=:all: -r "$gd_install_dir/requirements.txt"
python3 - "$gd_install_dir/gendragoon_gui.py" "$gd_bin_dir/gendragoon" "$gd_install_dir/venv/bin/python" <<'PY'
import pathlib,shlex,sys
target=pathlib.Path(sys.argv[2])
target.write_text('#!/bin/sh\nexec '+shlex.quote(sys.argv[3])+' -B '+shlex.quote(sys.argv[1])+' "$@"\n')
target.chmod(0o700)
PY
"$gd_bin_dir/gendragoon" --check
printf '%s\n' "Installed: $gd_bin_dir/gendragoon"
printf '%s\n' 'Run gendragoon to open the Files and Teams desktop window. Browser account approval and vault import happen there.'
