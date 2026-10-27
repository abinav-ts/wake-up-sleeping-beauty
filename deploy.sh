#!/usr/bin/env bash
# One-shot deploy using your normal `wrangler login` session (no API token needed).
# No secrets to manage: each device generates its own private ID on first launch.
set -euo pipefail
cd "$(dirname "$0")"
DB_NAME="wake-up-sleeping-beauty"

[ -d node_modules ] || npm install

# Make sure you're logged in (opens a browser only if you aren't).
npx wrangler whoami >/dev/null 2>&1 || npx wrangler login

# Create the D1 database (or reuse it) and write its id into wrangler.toml.
if grep -q REPLACE_AFTER_d1_create wrangler.toml; then
  OUT="$(npx wrangler d1 create "$DB_NAME" 2>&1 || true)"
  DB_ID="$(printf '%s' "$OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1 || true)"
  if [ -z "$DB_ID" ]; then
    DB_ID="$(npx wrangler d1 list --json | node -e \
      'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).find(d=>d.name===process.argv[1]);console.log(r?r.uuid:"")})' "$DB_NAME")"
  fi
  [ -n "$DB_ID" ] || { echo "Could not find the database id. Output was:"; echo "$OUT"; exit 1; }
  sed -i.bak "s/REPLACE_AFTER_d1_create/$DB_ID/" wrangler.toml && rm -f wrangler.toml.bak
  echo "D1 database id: $DB_ID"
fi

DEPLOY_OUT="$(npx wrangler deploy 2>&1 | tee /dev/stderr)"
URL="$(printf '%s' "$DEPLOY_OUT" | grep -Eo 'https://[A-Za-z0-9.-]+\.workers\.dev' | head -1 || true)"

echo
echo "Deployed: ${URL:-<see wrangler output above>}"
echo "Open it on your phone, Add to Home Screen, and you're in. Nothing to paste."
echo "Steps webhook: use the 'Copy steps webhook' button in the app."
