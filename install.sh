#!/bin/sh
# Install or update frame-jp-keyboard as a user service on a Steam Frame. Run it on the headset as
# the normal user (no sudo needed):
#   ./install.sh               install or update, then (re)start
#   ./install.sh --uninstall   stop and remove (restart Steam afterwards to fully unload)
#
# Files are taken from this directory: either the repository layout (dist/bundle.js,
# injector/frame_jp_keyboard_injector.py, contrib/frame-jp-keyboard.service,
# vendor/frame-updater/...) or all of them side by side (the release archive).
set -eu

here=$(cd "$(dirname "$0")" && pwd)
config_home=${XDG_CONFIG_HOME:-$HOME/.config}
share_dir="$HOME/.local/share/frame-jp-keyboard" # the unit refers to this path via %h
unit_dir="$config_home/systemd/user"
unit="frame-jp-keyboard.service"
app_config_dir="$config_home/frame-jp-keyboard"

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
update_script=$(find_file "$here/vendor/frame-updater/frame-update.sh" "$here/frame-update.sh")
update_python=$(find_file "$here/vendor/frame-updater/python/frame_update.py" "$here/frame_update.py")
# Optional: only written by `npm run build`/`package` (scripts/build.js), so a plain repository
# checkout that never built still installs; the injector then reports its version as "dev".
version_file=""
for candidate in "$here/dist/VERSION" "$here/VERSION"; do
    if [ -f "$candidate" ]; then
        version_file=$candidate
        break
    fi
done

if ! python3 -c 'import aiohttp' 2>/dev/null; then
    echo "python3 with aiohttp is required but 'import aiohttp' failed." >&2
    exit 1
fi

# Kana-kanji conversion runs in the injector with libanthy (the library ibus-anthy uses too).
if ! python3 -c 'import ctypes; ctypes.CDLL("libanthy.so.0")' 2>/dev/null; then
    echo "warning: libanthy.so.0 not found; the keyboard will type hiragana without conversion." >&2
fi

mkdir -p "$share_dir" "$unit_dir" "$app_config_dir"
cp "$bundle" "$share_dir/bundle.js"
cp "$injector" "$share_dir/frame_jp_keyboard_injector.py"
cp "$update_script" "$share_dir/frame-update.sh"
cp "$update_python" "$share_dir/frame_update.py"
chmod 644 "$share_dir/bundle.js" "$share_dir/frame_update.py"
chmod 755 "$share_dir/frame_jp_keyboard_injector.py" "$share_dir/frame-update.sh"
if [ -n "$version_file" ]; then
    cp "$version_file" "$share_dir/VERSION"
    chmod 644 "$share_dir/VERSION"
fi
cp "$service" "$unit_dir/$unit"
chmod 644 "$unit_dir/$unit"

# frame-update.sh re-runs this install.sh with these options when the user installs an update from
# the keyboard's indicator (see frame-updater/README.md); frame-jp-keyboard currently takes none.
cat >"$app_config_dir/install-args" <<'EOF'
# Options frame-update.sh's `install` passes to this install.sh (one per line, # is a comment).
# Written by install.sh itself; frame-jp-keyboard currently has no options to record.
EOF

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
  Update:     tap the small dot on the keyboard, or set __fjk.settings.updateCheck = false
              in the CDP console to stop the automatic (startup/hourly) check
  Uninstall:  $0 --uninstall
EOF
