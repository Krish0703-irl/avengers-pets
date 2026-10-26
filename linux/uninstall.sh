#!/bin/sh
# Removes Avengers Pets: puts the heroes away, then deletes the app, its app-menu entry,
# its log-in startup entry and its saved settings.
set -e

DATA_DIR="$HOME/.local/share/avengers-pets"

# Put away a running copy: only gjs processes running the installed app.
for pid in $(pgrep -x gjs 2>/dev/null); do
    if tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q "$DATA_DIR/app/avengers-pets.js"; then
        kill -TERM "$pid" 2>/dev/null || true
    fi
done

rm -rf "$DATA_DIR"
rm -f "$HOME/.local/share/applications/avengers-pets.desktop" "$HOME/.config/autostart/avengers-pets.desktop"
echo "Avengers Pets has been removed."
