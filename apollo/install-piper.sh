#!/usr/bin/env bash
# Gives !say piper's natural voice (apollo-sound uses espeak-ng's robot voice without it).
# Run it on apollo, from this folder, after install.sh:   sudo bash install-piper.sh
#   piper   the AUR package piper-tts-bin at a fixed commit: piper's official release, checked against the
#           PKGBUILD's SHA-256 and built as you (makepkg won't run as root)
#   voice   en_US lessac (medium) from piper's voice library at a fixed revision, checked by its SHA-256
# Safe to run again. apollo-sound picks the voice up on the next !say; no restart needed.
set -euo pipefail
cd "$(dirname "$0")"
[ "$(id -u)" = 0 ] && [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != root ] ||
    { echo "Run it with sudo from your own account: sudo bash install-piper.sh" >&2; exit 1; }

AUR_COMMIT=020c9a986568e4ca5e6018d11d11a52b9316b911      # piper-tts-bin 2023.11.14-3
VOICE_DIR=/usr/share/piper-voices/en/en_US/lessac/medium
VOICE_URL=https://huggingface.co/rhasspy/piper-voices/resolve/4a409e3cbfd0a189930b38f127a38e107677e8ac/en/en_US/lessac/medium/en_US-lessac-medium
VOICE_SHA256=5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f
CONFIG_SHA256=efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0

# As you, with your own home folder (sudo leaves HOME pointing at root's) and from a folder you can enter.
as_you() { (cd /tmp && runuser -u "$SUDO_USER" -- env HOME="$(getent passwd "$SUDO_USER" | cut -d: -f6)" "$@"); }

echo "== piper (AUR: piper-tts-bin)"
if pacman -Q piper-tts-bin >/dev/null 2>&1; then
    echo "already installed"
else
    pacman -S --needed --noconfirm base-devel git
    build=$(as_you mktemp -d)
    trap 'rm -rf "$build"' EXIT
    as_you git clone --quiet https://aur.archlinux.org/piper-tts-bin.git "$build/piper"
    as_you git -C "$build/piper" checkout --quiet "$AUR_COMMIT"
    as_you sh -c 'cd "$1" && makepkg --noconfirm' - "$build/piper"      # downloads the release and checks it
    pacman -U --noconfirm "$build"/piper/piper-tts-bin-*.pkg.tar.zst
fi

echo "== Voice: en_US lessac (medium)"
fetch() {   # url sha256 destination
    [ -f "$3" ] && echo "$2  $3" | sha256sum -c --quiet - 2>/dev/null && { echo "already there: $3"; return; }
    curl -fsSL --retry 3 -o "$3.part" "$1"
    if ! echo "$2  $3.part" | sha256sum -c --quiet -; then
        rm -f "$3.part"
        echo "The download of $1 didn't match its checksum; nothing was installed." >&2
        exit 1
    fi
    chmod 0644 "$3.part"
    mv "$3.part" "$3"
}
install -d -m 0755 "$VOICE_DIR"
fetch "$VOICE_URL.onnx.json" "$CONFIG_SHA256" "$VOICE_DIR/en_US-lessac-medium.onnx.json"
fetch "$VOICE_URL.onnx" "$VOICE_SHA256" "$VOICE_DIR/en_US-lessac-medium.onnx"

echo "== Check: apollo-sound's account can speak with it"
check=/var/lib/apollo-sound/piper-check.wav
if (cd / && echo "piper is ready" | runuser -u apollo-sound -- env HOME=/var/lib/apollo-sound /usr/bin/piper-tts \
        --model "$VOICE_DIR/en_US-lessac-medium.onnx" --output_file "$check" >/dev/null 2>&1) && [ -s "$check" ]; then
    rm -f "$check"
    echo "Done. The next !say uses piper's voice."
else
    rm -f "$check"
    echo "piper didn't work for apollo-sound, so !say keeps using espeak-ng. Try: /usr/bin/piper-tts --help" >&2
    exit 1
fi
