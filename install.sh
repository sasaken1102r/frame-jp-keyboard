#!/bin/sh
# Install or update frame-jp-keyboard as a user service on a Steam Frame. Run it on the headset as
# the normal user (no sudo needed):
#   ./install.sh               install or update, then (re)start
#   ./install.sh --uninstall   stop and remove (restart Steam afterwards to fully unload)
#
# Files are taken from this directory: either the repository layout (dist/bundle.js,
# injector/frame_jp_keyboard_injector.py, contrib/frame-jp-keyboard.service) or all three side by side.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
config_home=${XDG_CONFIG_HOME:-$HOME/.config}
share_dir="$HOME/.local/share/frame-jp-keyboard" # the unit refers to this path via %h
unit_dir="$config_home/systemd/user"
unit="frame-jp-keyboard.service"

# Print the first existing file among the arguments.
find_file() {
    for candidate in "$@"; do
        if [ -f "$candidate" ]; then
            printf '%s\n' "$candidate"
            return 0
        fi
    done
    echo "Missing file: $1" >&2
    return 1
}

if [ "${1:-}" = "--uninstall" ]; then
    systemctl --user disable --now "$unit" 2>/dev/null || true
    rm -f "$unit_dir/$unit"
    rm -rf "$share_dir"
    systemctl --user daemon-reload
    cat <<EOF
Removed frame-jp-keyboard.
The keyboard code is still loaded in the running Steam client. Restart Steam (or reboot) to fully
unload it and get the stock keyboard back.
EOF
    exit 0
fi

bundle=$(find_file "$here/dist/bundle.js" "$here/bundle.js")
injector=$(find_file "$here/injector/frame_jp_keyboard_injector.py" "$here/frame_jp_keyboard_injector.py")
service=$(find_file "$here/contrib/$unit" "$here/$unit")

if ! python3 -c 'import aiohttp' 2>/dev/null; then
    echo "python3 with aiohttp is required but 'import aiohttp' failed." >&2
    exit 1
fi

mkdir -p "$share_dir" "$unit_dir"
cp "$bundle" "$share_dir/bundle.js"
cp "$injector" "$share_dir/frame_jp_keyboard_injector.py"
chmod 644 "$share_dir/bundle.js"
chmod 755 "$share_dir/frame_jp_keyboard_injector.py"
cp "$service" "$unit_dir/$unit"
chmod 644 "$unit_dir/$unit"

systemctl --user daemon-reload
systemctl --user enable "$unit"
systemctl --user restart "$unit"
sleep 2
systemctl --user --no-pager status "$unit" | head -n 5 || true

# The service only injects when no instance is loaded, so replace a running (older) one now.
if python3 "$share_dir/frame_jp_keyboard_injector.py" --once --bundle "$share_dir/bundle.js"; then
    :
else
    echo "(Steam's CDP is not reachable right now; the service injects once Steam is running.)"
fi

cat <<EOF

frame-jp-keyboard is installed and injects itself whenever Steam runs.
  Logs:       journalctl --user -u frame-jp-keyboard -f
  Re-inject:  python3 $share_dir/frame_jp_keyboard_injector.py --once
  Uninstall:  $0 --uninstall
EOF
