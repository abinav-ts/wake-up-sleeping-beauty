#!/usr/bin/env bash
# Creates the GitHub repo, pushes, and turns on GitHub Pages (from /docs). Needs `gh auth login` once.
set -euo pipefail
cd "$(dirname "$0")"
REPO="wake-up-sleeping-beauty"

gh auth status >/dev/null 2>&1 || gh auth login

[ -d .git ] || git init -b main
# Use your own git identity; fall back to your GitHub no-reply address.
if [ -z "$(git config user.email || true)" ]; then
  read -r ID LOGIN < <(gh api user --jq '"\(.id) \(.login)"')
  git config user.name "$LOGIN"
  git config user.email "${ID}+${LOGIN}@users.noreply.github.com"
fi

git add -A
if ! git diff --cached --quiet; then
  git commit -q -m "Wake Up, Sleeping Beauty: chaos alarm PWA on Cloudflare Workers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_017DpXg7mQSSyLTo8y8pzXRi"
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  gh repo create "$REPO" --public --source . --remote origin --push \
    --description "Alarm clock that adds hidden random chaos to your next alarm if you oversleep, unless you walk 10,000 steps."
else
  git push -u origin main
fi

# Enable Pages from main:/docs (ignore the error if it is already enabled).
gh api -X POST "repos/{owner}/{repo}/pages" -f "source[branch]=main" -f "source[path]=/docs" >/dev/null 2>&1 || true
echo
echo "Repo:  $(gh repo view --json url --jq .url)"
echo "Pages: $(gh api "repos/{owner}/{repo}/pages" --jq .html_url 2>/dev/null || echo '(building; check repo Settings > Pages)')"
echo "Pages can take a minute or two to go live."
