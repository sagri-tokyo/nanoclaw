#!/bin/bash
# preapprove.sh — Merge setup-permissions.json into .claude/settings.json's
# permissions.allow array. Idempotent. Runs before bootstrap, so it can't
# assume node/pnpm are installed. Uses python3 (preinstalled on modern macOS
# and virtually every Linux distro).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
PERMS_FILE="$PROJECT_ROOT/.claude/skills/setup/setup-permissions.json"
SETTINGS_FILE="$PROJECT_ROOT/.claude/settings.json"

emit() {
  echo "=== PREAPPROVE ==="
  echo "STATUS: $1"
  shift
  for line in "$@"; do echo "$line"; done
  echo "=== END ==="
}

if [ ! -f "$PERMS_FILE" ]; then
  emit "failed" "REASON: $PERMS_FILE not found"
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  emit "needs_manual" "REASON: python3 not available; approve commands individually"
  exit 0
fi

mkdir -p "$(dirname "$SETTINGS_FILE")"
[ -f "$SETTINGS_FILE" ] || echo '{}' > "$SETTINGS_FILE"

OUTPUT=$(python3 - "$PERMS_FILE" "$SETTINGS_FILE" <<'PY'
import json, sys
perms_path, settings_path = sys.argv[1], sys.argv[2]
with open(perms_path) as f:
    perms = json.load(f)
with open(settings_path) as f:
    settings = json.load(f)
settings.setdefault('permissions', {}).setdefault('allow', [])
existing = set(settings['permissions']['allow'])
added = [p for p in perms if p not in existing]
settings['permissions']['allow'].extend(added)
with open(settings_path, 'w') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')
print(f"ADDED: {len(added)}")
print(f"SKIPPED: {len(perms) - len(added)}")
PY
)

emit "success" "$OUTPUT"
