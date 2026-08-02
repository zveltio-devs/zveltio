#!/usr/bin/env bash
# Generează versions.json din GitHub Releases API
# Usage: ./scripts/generate-versions-json.sh <repo> <output_file>

set -euo pipefail

REPO="${1:-zveltio/zveltio}"
OUTPUT="${2:-versions.json}"
API_URL="https://api.github.com/repos/${REPO}/releases"

# Authenticated when a token is available. Unauthenticated calls to the GitHub
# API are limited to 60 per hour PER IP, and Actions runners share a pool of
# them — so this worked for months and then returned 403 in the middle of the
# beta.44 release for no reason of ours. With the token the limit is per-repo
# and this stops being a coin flip.
AUTH_HEADER=()
if [[ -n "${GITHUB_TOKEN:-}" ]]; then
  AUTH_HEADER=(-H "Authorization: Bearer ${GITHUB_TOKEN}")
fi

RELEASES=$(curl -fsSL \
  -H "Accept: application/vnd.github.v3+json" \
  "${AUTH_HEADER[@]}" \
  "${API_URL}?per_page=50")

echo "$RELEASES" | jq --arg repo "$REPO" '
  [.[] | select(.draft == false) | {
    version: (.tag_name | ltrimstr("v")),
    channel: (if .prerelease then (
        if (.tag_name | test("-alpha\\.")) then "alpha"
        elif (.tag_name | test("-rc\\.")) then "rc"
        else "beta"
        end
      ) else "stable" end),
    published_at: .published_at,
    breaking_changes: (.body | test("BREAKING") // false),
    release_notes: .html_url,
    assets: (
      .assets | map({
        (.name): .browser_download_url
      }) | add // {}
    )
  }]
  | {
    latest: (map(select(.channel == "stable")) | first | .version),
    latest_alpha: (map(select(.channel == "alpha")) | first | .version // null),
    latest_beta: (map(select(.channel == "beta")) | first | .version // null),
    latest_rc: (map(select(.channel == "rc")) | first | .version // null),
    updated_at: (now | todate),
    versions: .
  }
' > "$OUTPUT"

echo "✅ Generated ${OUTPUT}"
