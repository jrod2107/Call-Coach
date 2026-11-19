#!/bin/bash
# Nightly off-site backup for the office Mac. Downloads the latest database copy from Supabase, compresses it,
# encrypts it, and saves it to the NAS. Run by launchd (see the .plist next to this file); safe to run by hand.
#
#   backup.sh           fetch today's copy if it is not on the NAS yet
#   backup.sh verify    decrypt the newest file on the NAS and check it opens (changes nothing)
#
# Secrets come from the Mac's Keychain (created by setup-keys.sh). Nothing secret is in this file.
set -u -o pipefail

API="https://skwgnvxjwfrkgzxrdfhe.supabase.co/rest/v1/rpc/backup_export"
APIKEY="sb_publishable_3N-tsu-oX4DZyDdsYt5gSA_hSDbexOa"   # public key, same one the web pages use
SHARE="/Volumes/personal_folder"
SHARE_URL="smb://DXP2800-8EE1/personal_folder"
DEST="$SHARE/CA Hub Backup"
KEEP_DAYS=90
LOG="$HOME/Library/Logs/cahub-backup.log"

say() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }
fail() { say "FAILED: $*"; exit 1; }

PASS="$(security find-generic-password -a cahub -s cahub-backup-passphrase -w 2>/dev/null)" || fail "no passphrase in the Keychain (run setup-keys.sh)"
export CAHUB_PASS="$PASS"

# Connect the NAS if it is not connected (uses the sign-in the Mac already remembers).
if [ ! -d "$DEST" ]; then
  osascript -e "mount volume \"$SHARE_URL\"" >/dev/null 2>&1
  for _ in 1 2 3 4 5 6; do [ -d "$DEST" ] && break; sleep 5; done
fi
[ -d "$DEST" ] || fail "the NAS folder is not reachable: $DEST"

if [ "${1:-}" = "verify" ]; then
  NEWEST="$(ls -t "$DEST"/cahub-*.json.gz.enc 2>/dev/null | head -1)"
  [ -n "$NEWEST" ] || fail "no backup files on the NAS yet"
  # First a full pass: decrypt everything and check the compressed data is intact end to end.
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:CAHUB_PASS -in "$NEWEST" | gunzip -t \
    || fail "could not decrypt $NEWEST"
  # Then peek at the start. head stops reading early, which is expected, so that exit status is ignored.
  SUMMARY="$( (openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:CAHUB_PASS -in "$NEWEST" | gunzip -c | head -c 200 | tr -d '\n') 2>/dev/null || true)"
  case "$SUMMARY" in
    '{"id"'*) say "verify OK: $(basename "$NEWEST") decrypts and is intact" ;;
    *) fail "decrypted $NEWEST but it does not look like a backup" ;;
  esac
  exit 0
fi

OUT="$DEST/cahub-$(date +%Y-%m-%d).json.gz.enc"
if [ -s "$OUT" ]; then say "today's copy is already on the NAS, nothing to do"; exit 0; fi

TOKEN="$(security find-generic-password -a cahub -s cahub-backup-token -w 2>/dev/null)" || fail "no download key in the Keychain (run setup-keys.sh)"

# The key goes in the request body through stdin, so it never appears in the process list.
TMP="$OUT.part"
if ! printf '{"p_token":"%s"}' "$TOKEN" \
   | curl -sS -f -m 300 -X POST "$API" -H "apikey: $APIKEY" -H "Content-Type: application/json" --data-binary @- \
   | gzip -c \
   | openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -pass env:CAHUB_PASS -out "$TMP"; then
  rm -f "$TMP"; fail "download or encryption failed (is the key registered, and is the internet up?)"
fi
SIZE=$(stat -f %z "$TMP")
if [ "$SIZE" -lt 20000 ]; then rm -f "$TMP"; fail "the downloaded copy is suspiciously small ($SIZE bytes)"; fi
mv "$TMP" "$OUT"

# Keep 90 days of nightly files.
find "$DEST" -name 'cahub-*.json.gz.enc' -mtime +"$KEEP_DAYS" -delete
say "saved $(basename "$OUT") ($SIZE bytes); $(ls "$DEST"/cahub-*.json.gz.enc | wc -l | tr -d ' ') copies on the NAS"
