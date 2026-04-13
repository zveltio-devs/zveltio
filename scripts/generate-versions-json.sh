#!/usr/bin/env bash
# Generează versions.json din GitHub Releases API
# Usage: ./scripts/generate-versions-json.sh <repo> <output_file>

set -euo pipefail

REPO="${1:-zveltio/zveltio}"
OUTPUT="${2:-versions.json}"
API_URL="https://api.github.com/repos/${REPO}/releases"

RELEASES=$(curl -fsSL \
  -H "Accept: application/vnd.github.v3+json" \
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
