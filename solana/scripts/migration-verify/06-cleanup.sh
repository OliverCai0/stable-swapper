#!/usr/bin/env bash
# Phase 06: restore committed program ID pins; optionally purge local artifacts.
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"

PURGE=false
for arg in "$@"; do
  case "$arg" in
    --purge) PURGE=true ;;
    --help|-h)
      echo "Usage: bash scripts/migration-verify/06-cleanup.sh [--purge]"
      echo "  Restores declare_id! and Anchor.toml pins."
      echo "  --purge also removes .migration-verify/ (and stops local validator)."
      echo "  Does NOT close on-chain programs on devnet (optional reclaim below)."
      exit 0
      ;;
  esac
done

banner "06 — CLEANUP [$MIGRATION_VERIFY_CLUSTER]" \
  "restore committed program ID pins"

cd "$REPO_ROOT"
git checkout -- \
  solana/programs/stable-swapper/src/lib.rs \
  solana/Anchor.toml
say_ok "Restored declare_id! and Anchor.toml"

if [[ -d "$LEGACY_WORKTREE" ]]; then
  git worktree remove --force "$LEGACY_WORKTREE" 2>/dev/null || rm -rf "$LEGACY_WORKTREE"
  echo "✓ Removed legacy worktree"
fi

if [[ "$MIGRATION_VERIFY_CLUSTER" == "localnet" && -f "$VALIDATOR_PID_PATH" ]]; then
  PID="$(cat "$VALIDATOR_PID_PATH")"
  echo
  echo "Local validator was started with pid $PID (ledger: $LEDGER_DIR)."
  echo "Stop it with: kill $PID"
  echo "  (or: pkill -f 'solana-test-validator' )"
fi

if [[ "$MIGRATION_VERIFY_CLUSTER" == "devnet" && -f "$STATE_PATH" ]]; then
  PROGRAM_ID="$(state_get programId 2>/dev/null || true)"
  if [[ -n "${PROGRAM_ID:-}" ]]; then
    echo
    echo "Ephemeral devnet program left on-chain: $PROGRAM_ID"
    echo "Explorer: https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet"
    echo "Optional rent reclaim (closes program — irreversible):"
    echo "  solana program close $PROGRAM_ID --url https://api.devnet.solana.com \\"
    echo "    --bypass-warning"
  fi
fi

if [[ "$PURGE" == "true" ]]; then
  if [[ -f "$VALIDATOR_PID_PATH" ]]; then
    PID="$(cat "$VALIDATOR_PID_PATH")"
    kill "$PID" 2>/dev/null || true
  fi
  rm -rf "$VERIFY_DIR"
  echo "✓ Purged $VERIFY_DIR"
else
  echo
  echo "Left artifacts in $VERIFY_DIR for inspection."
  echo "Re-run with --purge to delete them locally."
fi

echo
say_ok "Cleanup complete."
