#!/bin/sh
set -eu

if [ "${1:-}" = "--help" ] || [ "${1:-}" = "-h" ]; then
  echo 'Usage: ./install.sh'
  echo 'Install locked dependencies and link agent-plan into the current npm global prefix.'
  echo 'Requires Node >=22.19.0, npm and Git. Run again after switching NVM versions.'
  exit 0
fi
if [ "$#" -ne 0 ]; then
  echo 'Unknown argument. Use ./install.sh --help.' >&2
  exit 1
fi
for dependency in node npm git; do
  if ! command -v "$dependency" >/dev/null 2>&1; then
    echo "Missing $dependency. Install it, then rerun this script." >&2
    exit 1
  fi
done
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 19)) { console.error("Node >=22.19.0 is required; found " + process.versions.node); process.exit(1); }'
repo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cd "$repo_dir"
npm ci --no-audit --no-fund
npm link --ignore-scripts --no-audit --no-fund
node runner/cli.js help
printf '\nInstalled from %s\n' "$repo_dir"
printf 'Global command directory: %s/bin\n' "$(npm prefix -g)"
echo 'Keep this checkout: the installed command links to it.'
if ! command -v agent-plan >/dev/null 2>&1; then
  echo 'Add the global command directory above to PATH, then open a new terminal.'
fi
if ! command -v herdr >/dev/null 2>&1; then
  echo 'Herdr is not on PATH. Install/start Herdr before launching agent tasks.'
fi
echo 'Next: configure Pi credentials, start Herdr, and run agent-plan help start.'
