#!/usr/bin/env bash
# Bootstrap benchmark/model assets into an isolated worktree without
# duplicating or tracking them.
#
# The benchmark harness and its tests need artifacts that are deliberately
# NOT committed: the local model files under models/ (gitignored, multi-GB),
# the librispeech audio corpus under benchmarks/datasets/librispeech-t3/
# (gitignored *.wav), and accepted result-run directories under
# benchmarks/results/.
#
# This script exposes them from a checkout that already has them (the
# "primary" checkout) into the current worktree:
#   - models/ and the librispeech corpus are hardlinked (cp -al), because
#     the checksum verifiers deliberately reject paths that resolve outside
#     the repo root (symlinks would escape it). Hardlinks cost ~0 extra
#     disk and resolve inside the root.
#   - result-run directories are symlinked; the harness reads them without
#     a path-safety check, so symlinks are fine.
#   - a worktree-scoped .local-exclude file keeps all of it out of git
#     status without touching tracked .gitignore or the primary checkout.
#
# Nothing here is added to git, and the checksum/path-safety validation in
# benchmarks/harness/checksums.py is left untouched.
#
# Usage:
#   pnpm bootstrap:assets                      # auto-detect primary checkout
#   scripts/bootstrap-worktree-assets.sh /path/to/primary   # explicit
#
# The primary checkout is auto-detected as the main git worktree (first
# entry of `git worktree list`). Run this from a worktree, not from the
# primary checkout itself.
set -euo pipefail

root=$(cd "$(dirname "$0")/.." && pwd)
cd "$root"

primary="${1:-}"
if [[ -z "$primary" ]]; then
  primary=$(git worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2; exit}')
fi
[[ -n "$primary" ]] || { echo "could not detect a primary checkout; pass one explicitly" >&2; exit 1; }
primary=$(cd "$primary" && pwd)

if [[ "$primary" == "$root" ]]; then
  echo "this is the primary checkout itself; run the script from a worktree" >&2
  exit 1
fi

[[ -d "$primary/models" ]] || { echo "primary checkout has no models/: $primary" >&2; exit 1; }
[[ -d "$primary/benchmarks/results" ]] || { echo "primary checkout has no benchmarks/results/: $primary" >&2; exit 1; }

link_dir() { # name, primary path, local path
  local label="$1" from="$2" to="$3"
  if [[ -L "$to" ]]; then
    rm "$to"
  elif [[ -e "$to" ]]; then
    echo "skip $label: $to already exists (not a symlink); remove it first if you want it replaced" >&2
    return
  fi
  ln -s "$from" "$to"
  echo "linked $label -> $from"
}

hardlink_tree() { # label, primary path, local path
  local label="$1" from="$2" to="$3"
  if [[ -e "$to" ]]; then
    echo "skip $label: $to already exists; remove it first if you want it re-linked" >&2
    return
  fi
  cp -al "$from" "$to"
  echo "hardlinked $label -> $from"
}

hardlink_tree "models" "$primary/models" "$root/models"
hardlink_tree "librispeech corpus" "$primary/benchmarks/datasets/librispeech-t3" "$root/benchmarks/datasets/librispeech-t3"

linked_results=0
for dir in "$primary"/benchmarks/results/*/; do
  name=$(basename "$dir")
  [[ "$name" == "schema" ]] && continue
  link_dir "result dir $name" "$dir" "$root/benchmarks/results/$name"
  linked_results=$((linked_results + 1))
done

# Worktree-scoped ignore rules. Trailing-slash gitignore rules do not match
# symlinks, so the linked artifacts would otherwise show up as untracked.
# Tracked files (e.g. benchmarks/results/schema) are never affected by
# ignore rules, so the broad results pattern is safe.
exclude="$root/.local-exclude"
cat > "$exclude" <<'EOF'
/.local-exclude
/models
/benchmarks/datasets/librispeech-t3
/benchmarks/results/*
EOF
git config extensions.worktreeConfig true
git config --worktree core.excludesFile "$exclude"

if [[ -n "$(git status --short)" ]]; then
  echo "WARNING: git status is not clean after bootstrapping:" >&2
  git status --short >&2
  exit 1
fi

echo "bootstrap complete (primary: $primary)"
echo "  models: hardlinked, librispeech corpus: hardlinked, result dirs: $linked_results symlinked"
echo "  ignored via $exclude (worktree-scoped); git status is clean"
