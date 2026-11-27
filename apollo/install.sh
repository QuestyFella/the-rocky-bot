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
KIOSK_KNOWN=(
    7fda643d44946b073a52ac9981d3ab127ca8f4ae6139c57de9451c6c9c3ffb21   # the kiosk that beeped by itself
    4ae0442f54eace69230f8031480e7861510e480036f00221aeb368daecb370e4   # apollo-sound kiosk (before space page)
    db7006af0f9ddf3cb24c6fdf479f1d72d53ecfd2ff6002ff0b35b21fef7c0e68   # space dashboard kiosk (before borrow)
)

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

echo "== rocky-space-export (ISS/Tiangong passes, HF propagation, space news, launches)"
id rocky-space >/dev/null 2>&1 ||
    useradd --system --home-dir /var/lib/rocky-space --no-create-home --shell /usr/bin/nologin rocky-space
install -d -o rocky-space -g rocky-space -m 0755 /var/lib/rocky-space
install -m 0755 rocky-space-export /usr/local/libexec/rocky-space-export
install -m 0644 rocky-space-export.service /etc/systemd/system/rocky-space-export.service
install -m 0644 rocky-space-export.timer /etc/systemd/system/rocky-space-export.timer
systemctl daemon-reload
systemctl enable --now rocky-space-export.timer
systemctl start --no-block rocky-space-export.service

echo "== apollo-sso (club-wide SSO via Gitea OAuth2/OIDC)"
id apollo-sso >/dev/null 2>&1 ||
    useradd --system --home-dir /nonexistent --no-create-home --shell /usr/bin/nologin apollo-sso
install -d -o root -g apollo-sso -m 0750 /etc/apollo-sso
if [ ! -f /etc/apollo-sso/config.json ]; then
    python3 - <<'EOF'
import json, os, secrets
cfg = {
    "client_id": "",
    "client_secret": "",
    "session_secret": secrets.token_hex(32),
    "gitea_public_url": "http://10.16.26.107/gitea",
    "gitea_internal_url": "http://127.0.0.1:3000",
    "redirect_uri": "http://10.16.26.107/sso/callback",
    "session_ttl": 604800,
}
with open("/etc/apollo-sso/config.json", "w", encoding="utf8") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
EOF
    chown root:apollo-sso /etc/apollo-sso/config.json
    chmod 0640 /etc/apollo-sso/config.json
    echo "created /etc/apollo-sso/config.json (run: sudo apollo-sso --configure)"
fi
install -m 0755 apollo-sso /usr/local/bin/apollo-sso
install -m 0644 apollo-sso.service /etc/systemd/system/apollo-sso.service
systemctl daemon-reload
systemctl enable apollo-sso
systemctl restart apollo-sso

echo "== apollo-borrow (equipment borrow tracker web UI + kiosk form)"
id apollo-borrow >/dev/null 2>&1 ||
    useradd --system --home-dir /var/lib/apollo-borrow --no-create-home --shell /usr/bin/nologin apollo-borrow
install -d -o apollo-borrow -g apollo-borrow -m 0755 /var/lib/apollo-borrow
install -m 0755 apollo-borrow /usr/local/bin/apollo-borrow
install -m 0644 apollo-borrow.service /etc/systemd/system/apollo-borrow.service
systemctl daemon-reload
systemctl enable apollo-borrow
systemctl restart apollo-borrow

if [ -f /etc/nginx/nginx.conf ] && ! grep -q "location \^~ /sso/" /etc/nginx/nginx.conf; then
    cp -p /etc/nginx/nginx.conf /etc/nginx/nginx.conf.bak-sso-borrow
    python3 - <<'EOF'
path = "/etc/nginx/nginx.conf"
text = open(path, encoding="utf8").read()
block = """
        # Club-wide SSO (Gitea OAuth2/OIDC): /sso/ -> 127.0.0.1:3005
        location = /sso {
            return 301 /sso/;
        }
        location ^~ /sso/ {
            proxy_pass http://127.0.0.1:3005/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
        }
        location = /_sso_check {
            internal;
            proxy_pass http://127.0.0.1:3005/verify;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            proxy_set_header Cookie $http_cookie;
        }
        location = /_sso_optional {
            internal;
            proxy_pass http://127.0.0.1:3005/verify?optional=1;
            proxy_pass_request_body off;
            proxy_set_header Content-Length "";
            proxy_set_header Cookie $http_cookie;
        }
        location @sso_login {
            return 302 /sso/login?next=$request_uri;
        }

        # Club equipment borrow tracker: /borrow/ -> 127.0.0.1:3010
        location = /borrow {
            return 301 /borrow/;
        }
        location ^~ /borrow/ {
            auth_request /_sso_optional;
            auth_request_set $apollo_sso $upstream_http_x_apollo_sso;
            auth_request_set $apollo_user $upstream_http_x_apollo_user;
            auth_request_set $apollo_name $upstream_http_x_apollo_name;
            auth_request_set $apollo_admin $upstream_http_x_apollo_admin;
            proxy_pass http://127.0.0.1:3010/;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
            proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_set_header X-Apollo-SSO $apollo_sso;
            proxy_set_header X-Apollo-User $apollo_user;
            proxy_set_header X-Apollo-Name $apollo_name;
            proxy_set_header X-Apollo-Admin $apollo_admin;
        }
"""
marker = "        # Never serve dotfiles"
if marker in text:
    updated = text.replace(marker, block + "\n" + marker, 1)
else:
    idx = text.rfind("}")
    idx = text.rfind("}", 0, idx)
    updated = text[:idx] + block + text[idx:]
open(path, "w", encoding="utf8").write(updated)
EOF
    if nginx -t; then
        systemctl reload nginx
        echo "nginx: added /sso/ and /borrow/ proxies and reloaded"
    else
        cp -p /etc/nginx/nginx.conf.bak-sso-borrow /etc/nginx/nginx.conf
        echo "ERROR: nginx -t failed after adding /sso/ and /borrow/; restored backup." >&2
        exit 1
    fi
fi

echo "== Kiosk board (apollo-sound quiet buzz + Space Dashboard + Borrow form)"
current=$(sha256sum "$KIOSK" | cut -d' ' -f1)
known=0
for h in "${KIOSK_KNOWN[@]}"; do
    [ "$current" = "$h" ] && known=1
done
if [ "$current" = "$(sha256sum rocky-board | cut -d' ' -f1)" ]; then
    echo "already up to date"
elif [ "$known" = 1 ]; then
    cp -p "$KIOSK" "$KIOSK.bak-$(date +%Y%m%d)"
    install -m 0755 rocky-board "$KIOSK"
    systemctl restart rocky-board-kiosk
    echo "updated; previous copy backed up beside $KIOSK"
else
    echo "WARNING: $KIOSK was changed by someone else since this was written, so it was left alone." >&2
    echo "         Review diffs and install apollo/rocky-board manually if you want the update." >&2
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
