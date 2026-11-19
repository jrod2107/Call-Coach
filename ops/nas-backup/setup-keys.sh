#!/bin/sh
# One-time setup, run by the owner on the office Mac. Creates two secrets and stores them in the Mac's Keychain:
#   cahub-backup-token       the key that lets this Mac download the nightly backup
#   cahub-backup-passphrase  the passphrase that encrypts the backup files on the NAS
# Neither secret is printed. The only thing printed is the token's fingerprint (a SHA-256 hash), which is safe
# to share: it is what the database stores to recognise the key, and it cannot be turned back into the key.
set -e
ACCOUNT="cahub"

if security find-generic-password -a "$ACCOUNT" -s cahub-backup-passphrase >/dev/null 2>&1; then
  echo "Passphrase already in the Keychain: kept as is (changing it would lock you out of older backup files)."
else
  security add-generic-password -a "$ACCOUNT" -s cahub-backup-passphrase -l "CA Hub backup passphrase" -w "$(openssl rand -base64 30)"
  echo "Created the encryption passphrase in the Keychain."
fi

TOKEN="$(openssl rand -hex 32)"
security add-generic-password -U -a "$ACCOUNT" -s cahub-backup-token -l "CA Hub backup download key" -w "$TOKEN"
echo "Created the download key in the Keychain."
echo
echo "FINGERPRINT (safe to share): $(printf %s "$TOKEN" | shasum -a 256 | cut -d' ' -f1)"
echo
echo "Now save the passphrase somewhere safe outside this Mac, for example your password manager:"
echo "  open Keychain Access, search for 'CA Hub backup passphrase', open it, tick Show password."
echo "Without that passphrase the files on the NAS cannot be opened."
