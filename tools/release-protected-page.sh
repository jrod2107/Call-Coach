#!/bin/sh
# Stores a protected page's content in the database (see supabase/migrations/*protected_pages.sql).
# The content file is private and is NOT in this repository.
#
#   tools/release-protected-page.sh hash  <content-file>          prints the SHA-256 to release
#   tools/release-protected-page.sh put   <slug> <content-file>   uploads it (works only after the release below)
#
# Between the two steps a database administrator runs, in the Supabase SQL editor:
#   insert into protected_page_releases (slug, sha256, roles, expires_at)
#   values ('<slug>', '<hash>', array['csr','admin','tech'], now() + interval '10 minutes');
# No key or password is used: the database accepts only the exact content that was released.
set -eu
case "${1:-}" in
  hash) shasum -a 256 "$2" | cut -d' ' -f1 ;;
  put)
    cfg="$(dirname "$0")/../config.js"
    url=$(sed -n 's/.*supabaseUrl: *"\([^"]*\)".*/\1/p' "$cfg")
    key=$(sed -n 's/.*supabaseAnonKey: *"\([^"]*\)".*/\1/p' "$cfg")
    python3 -I -c 'import json,sys;print(json.dumps({"p_slug":sys.argv[1],"p_html":open(sys.argv[2],encoding="utf-8",newline="").read()}))' "$2" "$3" \
      | curl -sS -X POST "$url/rest/v1/rpc/protected_page_put" -H "apikey: $key" -H "Content-Type: application/json" --data-binary @-
    echo ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
