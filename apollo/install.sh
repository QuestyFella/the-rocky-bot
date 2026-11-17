#!/usr/bin/env bash
# Sets up apollo's room speakers (apollo-sound: !buzz tunes, !say, !play) and NetHack with shared ghosts.
# Run it on apollo, from this folder:   sudo bash install.sh
# Safe to run again: it only changes what isn't set up yet. The bot side (!say, !play, NetHack
# announcements) arrives with the bot's normal deployment from main.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] || { echo "Run it with sudo: sudo bash install.sh" >&2; exit 1; }

BOT_USER=rockybot
KIOSK=/usr/local/bin/rocky-board
KIOSK_BEFORE=7fda643d44946b073a52ac9981d3ab127ca8f4ae6139c57de9451c6c9c3ffb21   # the kiosk that beeped by itself

echo "== Packages: nethack, mpv, yt-dlp, espeak-ng"
if ! pacman -S --needed --noconfirm nethack mpv yt-dlp espeak-ng; then
    echo "pacman couldn't install them. If a download wasn't found, update apollo first (sudo pacman -Syu), then run this again." >&2
    exit 1
fi

echo "== apollo-sound"
id apollo-sound >/dev/null 2>&1 ||
    useradd --system --home-dir /var/lib/apollo-sound --no-create-home --shell /usr/bin/nologin --groups audio apollo-sound
install -d -o apollo-sound -g apollo-sound -m 0755 /var/lib/apollo-sound
install -d -o apollo-sound -g "$BOT_USER" -m 2770 /var/lib/apollo-sound/requests    # the bot writes requests here
install -m 0755 apollo-sound /usr/local/bin/apollo-sound
install -m 0644 apollo-sound.service /etc/systemd/system/apollo-sound.service
systemctl daemon-reload
systemctl enable apollo-sound
systemctl restart apollo-sound

echo "== The kiosk stops beeping by itself (apollo-sound plays the !buzz tune)"
current=$(sha256sum "$KIOSK" | cut -d' ' -f1)
if [ "$current" = "$(sha256sum rocky-board | cut -d' ' -f1)" ]; then
    echo "already done"
elif [ "$current" = "$KIOSK_BEFORE" ]; then
    cp -p "$KIOSK" "$KIOSK.bak-apollo-sound"
    install -m 0755 rocky-board "$KIOSK"
    systemctl restart rocky-board-kiosk
    echo "updated; the old one is $KIOSK.bak-apollo-sound"
else
    echo "WARNING: $KIOSK was changed by someone else since this was written, so it was left alone." >&2
    echo "         Until its beep is removed, !buzz plays both its beeps and a tune." >&2
fi

echo "== NetHack: everyone shares one pool of ghosts (bones) and one high-score list"
sysconf=/etc/nethack/sysconf
if grep -qE '^BONES_POOLS=([2-9]|[0-9]{2,})' "$sysconf"; then
    cp -p "$sysconf" "$sysconf.bak-apollo-sound"
    sed -i -E 's/^BONES_POOLS=.*/BONES_POOLS=1/' "$sysconf"
    echo "bones pools: 1 (was split, so members would rarely meet each other's ghosts)"
fi
runuser -u "$BOT_USER" -- test -r /var/games/nethack/xlogfile ||
    echo "WARNING: the bot can't read /var/games/nethack/xlogfile, so deaths won't be announced." >&2

if ! grep -q nethack /etc/motd; then
    cp -p /etc/motd /etc/motd.bak-apollo-sound
    python3 - <<'EOF'
lines = open("/etc/motd").read().split("\n")
at = next((i + 1 for i, line in enumerate(lines) if line.startswith("  tasks ")), len(lines))
lines[at:at] = ["  games      nethack                    (others' ghosts haunt your dungeon; deaths go to #lobby)",
                "  speakers   !say  !play  !skip  !queue   (in #lobby; plays in the club room)"]
open("/etc/motd", "w").write("\n".join(lines))
EOF
    echo "added NetHack and the speakers to the login message"
fi

echo
systemctl --no-pager --lines=5 status apollo-sound | sed -n '1,3p;/^$/,$p' || true
echo
echo "Done. Try !buzz in #door-alarm: apollo should play one of the doorbell tunes."
