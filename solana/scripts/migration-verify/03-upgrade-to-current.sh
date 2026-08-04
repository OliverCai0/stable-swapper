#!/usr/bin/env bash
# Phase 03: build current (HEAD) program and upgrade the deployment.
set -euo pipefail

source "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"
ensure_dirs
require_state
export_cluster_env

PROGRAM_ID="$(state_get programId)"
POOL_PDA="$(state_get poolPda)"
RPC_URL="$(state_get rpcUrl)"

echo "============================================================"
echo "03 — UPGRADE TO CURRENT PROGRAM [$MIGRATION_VERIFY_CLUSTER]"
echo "============================================================"
echo "- Program ID: $PROGRAM_ID"
echo "- Pool PDA:   $POOL_PDA"
echo "- RPC:        $RPC_URL"
echo

# Working tree should already have declare_id! / cluster section patched from phase 00.
CURRENT_DECLARE="$(grep -oE 'declare_id!\("[^"]+"\)' "$LIB_RS" | head -1 || true)"
if [[ "$CURRENT_DECLARE" != *"$PROGRAM_ID"* ]]; then
  echo "Re-patching working tree to ephemeral program ID..."
  patch_program_id "$LIB_RS" "$ANCHOR_TOML" "$PROGRAM_ID" "$ANCHOR_PROGRAMS_SECTION"
fi

echo "Building current program..."
anchor_build_with_sbf_toolchain "$SOLANA_DIR"

cp "$SOLANA_DIR/target/deploy/scaas_liquidity.so" \
  "$ARTIFACTS_CURRENT/scaas_liquidity.so"
cp "$SOLANA_DIR/target/idl/scaas_liquidity.json" \
  "$ARTIFACTS_CURRENT/scaas_liquidity.json"

# Restore ephemeral program keypair (anchor build often writes a different one).
sync_program_keypair_to_deploy
cp "$STABLE_PROGRAM_KEYPAIR" "$VERIFY_DIR/scaas_liquidity-keypair.json"
BUILT_ID="$(solana address -k "$DEPLOY_KEYPAIR")"
if [[ "$BUILT_ID" != "$PROGRAM_ID" ]]; then
  echo "❌ Keypair address $BUILT_ID does not match state programId $PROGRAM_ID"
  exit 1
fi

echo "Upgrading on-chain program..."
solana program deploy \
  "$ARTIFACTS_CURRENT/scaas_liquidity.so" \
  --program-id "$PROGRAM_ID" \
  --url "$RPC_URL" \
  --keypair "$(state_get walletPath)"

# Best-effort IDL write; clients primarily use the file IDL under artifacts/.
echo "Writing on-chain IDL (best-effort)..."
(
  cd "$SOLANA_DIR"
  anchor idl upgrade --filepath target/idl/scaas_liquidity.json "$PROGRAM_ID" \
    --provider.cluster "$MIGRATION_VERIFY_CLUSTER" 2>/dev/null || \
  anchor idl init --filepath target/idl/scaas_liquidity.json "$PROGRAM_ID" \
    --provider.cluster "$MIGRATION_VERIFY_CLUSTER" 2>/dev/null || \
  echo "ℹ️  IDL on-chain write skipped; file IDL at artifacts/current will be used."
)

solana program show "$PROGRAM_ID" --url "$RPC_URL"

# Pool layout: 1719 before migrate, 2107 after. Allow either so this step can be
# re-run to hot-swap a rebuilt binary onto an already-migrated pool.
POOL_LEN="$(solana account "$POOL_PDA" --url "$RPC_URL" --output json \
  | node -e "
    let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
      const j=JSON.parse(d);
      const b=Buffer.from(j.account.data[0], 'base64');
      process.stdout.write(String(b.length));
    });
  ")"
echo "Pool data length after upgrade: $POOL_LEN"
if [[ "$POOL_LEN" == "1719" ]]; then
  echo "✓ Pool still legacy-sized after upgrade (migrate next)"
elif [[ "$POOL_LEN" == "2107" ]]; then
  echo "✓ Pool already migrated (2107); binary hot-swap only"
else
  echo "❌ Unexpected pool size $POOL_LEN (expected 1719 or 2107)"
  exit 1
fi

node -e "
const fs = require('fs');
const p = process.argv[1];
const s = JSON.parse(fs.readFileSync(p, 'utf8'));
s.phase = '03-upgraded';
fs.writeFileSync(p, JSON.stringify(s, null, 2) + '\n');
" "$STATE_PATH"

echo
echo "✓ Upgrade complete."
if [[ "$POOL_LEN" == "1719" ]]; then
  echo "Next: yarn ts-node scripts/migration-verify/04-migrate.ts"
else
  echo "Next: yarn ts-node scripts/migration-verify/05-smoke-authorities.ts"
fi
