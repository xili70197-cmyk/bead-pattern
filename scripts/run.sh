#!/usr/bin/env bash
set -euo pipefail
bead_script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
if command -v node >/dev/null 2>&1; then
  bead_node="$(command -v node)"
else
  bead_node=""
  for bead_candidate in "$HOME"/.workbuddy/binaries/node/versions/*/bin/node "$HOME"/.workbuddy/binaries/node/versions/*/node; do
    if [[ -x "$bead_candidate" ]]; then bead_node="$bead_candidate"; fi
  done
  if [[ -z "$bead_node" ]]; then printf '%s\n' '未找到 Node.js，请使用宿主运行时或 Node.js 20.9 以上版本。' >&2; exit 1; fi
fi
exec "$bead_node" --expose-gc "$bead_script_dir/bead.cjs" "$@"
