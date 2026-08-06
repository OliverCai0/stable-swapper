#!/usr/bin/env bash
# Phase 01: build pre-RBAC binary in a git worktree and deploy it.
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"
ensure_dirs
require_state
export_cluster_env

PROGRAM_ID="$(state_get programId)"
RPC_URL="$(state_get rpcUrl)"
sync_program_keypair_to_deploy
# Compat copy for older mid-run artifacts.
cp "$STABLE_PROGRAM_KEYPAIR" "$VERIFY_DIR/stable_swapper-keypair.json"

KP_ID="$(solana address -k "$DEPLOY_KEYPAIR")"
if [[ "$KP_ID" != "$PROGRAM_ID" ]]; then
  echo "❌ Deploy keypair $KP_ID != state programId $PROGRAM_ID"
  exit 1
fi

banner "01 — BUILD + DEPLOY LEGACY ($LEGACY_COMMIT) [$MIGRATION_VERIFY_CLUSTER]" \
  "the pre-RBAC binary, so the migration has something real to migrate"
echo "- Program ID: $PROGRAM_ID"
echo "- RPC:        $RPC_URL"
echo

# Fresh worktree at the pre-RBAC commit.
if [[ -d "$LEGACY_WORKTREE" ]]; then
  echo "Removing existing worktree at $LEGACY_WORKTREE..."
  git -C "$REPO_ROOT" worktree remove --force "$LEGACY_WORKTREE" 2>/dev/null || \
    rm -rf "$LEGACY_WORKTREE"
fi

echo "Creating git worktree at $LEGACY_COMMIT..."
git -C "$REPO_ROOT" worktree add --detach "$LEGACY_WORKTREE" "$LEGACY_COMMIT"
LEGACY_SOLANA="$LEGACY_WORKTREE/solana"

mkdir -p "$LEGACY_SOLANA/target/deploy"
cp "$DEPLOY_KEYPAIR" "$LEGACY_SOLANA/target/deploy/stable_swapper-keypair.json"

# Align program ID for the cluster section we care about (+ sibling sections if present).
patch_program_id \
  "$LEGACY_SOLANA/programs/stable-swapper/src/lib.rs" \
  "$LEGACY_SOLANA/Anchor.toml" \
  "$PROGRAM_ID" \
  "$ANCHOR_PROGRAMS_SECTION"
if grep -q '\[programs.localnet\]' "$LEGACY_SOLANA/Anchor.toml"; then
  patch_program_id \
    "$LEGACY_SOLANA/programs/stable-swapper/src/lib.rs" \
    "$LEGACY_SOLANA/Anchor.toml" \
    "$PROGRAM_ID" \
    "localnet"
fi
if grep -q '\[programs.devnet\]' "$LEGACY_SOLANA/Anchor.toml"; then
  patch_program_id \
    "$LEGACY_SOLANA/programs/stable-swapper/src/lib.rs" \
    "$LEGACY_SOLANA/Anchor.toml" \
    "$PROGRAM_ID" \
    "devnet"
fi
say_ok "Aligned legacy worktree program ID"

echo "Building legacy program (this may take a minute)..."
(
  cd "$LEGACY_SOLANA"
  if [[ -f package.json ]]; then
    yarn install --frozen-lockfile >/dev/null 2>&1 || yarn install >/dev/null 2>&1 || true
  fi
)
anchor_build_with_sbf_toolchain "$LEGACY_SOLANA"

cp "$LEGACY_SOLANA/target/deploy/stable_swapper.so" \
  "$ARTIFACTS_LEGACY/stable_swapper.so"
cp "$LEGACY_SOLANA/target/idl/stable_swapper.json" \
  "$ARTIFACTS_LEGACY/stable_swapper.json"
say_ok "Copied legacy artifacts to $ARTIFACTS_LEGACY"

echo "Deploying legacy program to $MIGRATION_VERIFY_CLUSTER..."
solana program deploy \
  "$ARTIFACTS_LEGACY/stable_swapper.so" \
  --program-id "$DEPLOY_KEYPAIR" \
  --url "$RPC_URL" \
  --keypair "$(state_get walletPath)"

solana program show "$PROGRAM_ID" --url "$RPC_URL"

node -e "
const fs = require('fs');
const p = process.argv[1];
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.legacyCommit = process.argv[2];
s.phase = '01-legacy-deployed';
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
" "$STATE_PATH" "$LEGACY_COMMIT"

echo
say_ok "Legacy program deployed."
echo "Next: yarn ts-node scripts/migration-verify/02-seed-legacy-pool.ts"
