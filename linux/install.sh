#!/bin/sh
# Installs Avengers Pets for the current user and lets the heroes out.
#
# From a download of this repo:   sh linux/install.sh
# Straight from GitHub:           curl -fsSL https://raw.githubusercontent.com/Krish0703-irl/avengers-pets/main/linux/install.sh | sh
#
# Options: --autostart   also start Avengers Pets every time you log in
#          --no-start    install without letting the heroes out right away
set -e

REPO_RAW="https://raw.githubusercontent.com/Krish0703-irl/avengers-pets/main"
APP_DIR="$HOME/.local/share/avengers-pets/app"
LAUNCHER="$HOME/.local/share/applications/avengers-pets.desktop"
AUTOSTART="$HOME/.config/autostart/avengers-pets.desktop"

autostart=""
start=yes
for arg in "$@"; do
    case "$arg" in
        --autostart) autostart=yes ;;
        --no-start) start="" ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

if ! command -v gjs >/dev/null 2>&1; then
    echo "Avengers Pets needs gjs, which comes with the GNOME desktop."
    echo "Install it with:  sudo apt install gjs"
    exit 1
fi

# Copy from next to this script (a downloaded zip or the repo), or fetch from GitHub.
here=$(cd "$(dirname "$0")" 2>/dev/null && pwd || echo .)
fetch() {
    # fetch <file in repo> <destination>
    for local in "$here/$(basename "$1")" "$here/../$1"; do
        if [ -f "$local" ]; then
            cp "$local" "$2"
            return
        fi
    done
    echo "Downloading $1 ..."
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL "$REPO_RAW/$1" -o "$2"
    else
        wget -qO "$2" "$REPO_RAW/$1"
    fi
}

mkdir -p "$APP_DIR" "$(dirname "$LAUNCHER")"
fetch avengers-pets.js "$APP_DIR/avengers-pets.js"
fetch images/icon.png "$APP_DIR/icon.png"
chmod +x "$APP_DIR/avengers-pets.js"

write_entry() {
    cat > "$1" <<EOF
[Desktop Entry]
Type=Application
Name=Avengers Pets
Comment=Spider-Man, Iron Man, Cap, Hulk, Thor, Black Widow, Hawkeye, Doctor Strange and Mochi on your screen
Exec=gjs -m $APP_DIR/avengers-pets.js
Icon=$APP_DIR/icon.png
Terminal=false
Categories=Game;
EOF
}
write_entry "$LAUNCHER"
echo "Added Avengers Pets to your app menu."

if [ -z "$autostart" ] && [ -t 0 ]; then
    printf "Start Avengers Pets automatically when you log in? [y/N] "
    read -r answer
    case "$answer" in [yY]*) autostart=yes ;; esac
fi
if [ -n "$autostart" ]; then
    mkdir -p "$(dirname "$AUTOSTART")"
    write_entry "$AUTOSTART"
    echo "Avengers Pets will start when you log in."
fi

if [ -n "$start" ]; then
    setsid gjs -m "$APP_DIR/avengers-pets.js" >/dev/null 2>&1 < /dev/null &
    echo "The heroes are out! Open Avengers Pets from your app menu any time to choose who stays."
else
    echo "Installed. Open Avengers Pets from your app menu to let the heroes out."
fi
