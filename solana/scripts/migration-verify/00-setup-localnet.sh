#!/usr/bin/env bash
# Phase 00: ephemeral program ID, local validator, airdrop, state file.
set -euo pipefail

export MIGRATION_VERIFY_CLUSTER=localnet
source "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"
ensure_dirs

WALLET_PATH="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
if [[ ! -f "$WALLET_PATH" ]]; then
  echo "❌ Wallet not found at $WALLET_PATH"
  echo "   Create one with: solana-keygen new -o $WALLET_PATH"
  exit 1
fi

echo "============================================================"
echo "00 — SETUP LOCALNET MIGRATION VERIFY"
echo "============================================================"
echo "- Solana dir: $SOLANA_DIR"
echo "- Wallet:     $WALLET_PATH"
echo

# Ephemeral program keypair (stable path + deploy copy).
solana-keygen new --no-bip39-passphrase --silent --force \
  --outfile "$STABLE_PROGRAM_KEYPAIR"
cp "$STABLE_PROGRAM_KEYPAIR" "$DEPLOY_KEYPAIR"
# Legacy path used by older mid-run artifacts.
cp "$STABLE_PROGRAM_KEYPAIR" "$VERIFY_DIR/stable_swapper-keypair.json"
PROGRAM_ID="$(solana address -k "$STABLE_PROGRAM_KEYPAIR")"
echo "✓ Ephemeral program ID: $PROGRAM_ID"

# Patch only localnet pins in the working tree (restored by 06-cleanup).
patch_program_id "$LIB_RS" "$ANCHOR_TOML" "$PROGRAM_ID" "localnet"
echo "✓ Patched declare_id! and [programs.localnet]"

# Start a dedicated local validator if one is not already reachable.
# Note: Agave 3.1.x test-validator has no --enable-rpc-transaction-history flag.
VALIDATOR_LOG="$VERIFY_DIR/validator-stdout.log"
if rpc_up "$LOCALNET_URL"; then
  echo "✓ Local validator already reachable at $LOCALNET_URL"
else
  echo "Starting solana-test-validator (ledger: $LEDGER_DIR)..."
  rm -rf "$LEDGER_DIR"
  mkdir -p "$LEDGER_DIR"
  solana-test-validator \
    --ledger "$LEDGER_DIR" \
    --reset \
    --quiet \
    >"$VALIDATOR_LOG" 2>&1 &
  echo $! >"$VALIDATOR_PID_PATH"
  echo "✓ Validator pid $(cat "$VALIDATOR_PID_PATH") (log: $VALIDATOR_LOG)"

  echo -n "Waiting for RPC"
  for _ in $(seq 1 60); do
    if ! kill -0 "$(cat "$VALIDATOR_PID_PATH")" 2>/dev/null; then
      echo
      echo "❌ solana-test-validator exited early. Last log lines:"
      tail -40 "$VALIDATOR_LOG" || true
      exit 1
    fi
    if rpc_up "$LOCALNET_URL"; then
      echo " ready."
      break
    fi
    echo -n "."
    sleep 1
  done
  if ! rpc_up "$LOCALNET_URL"; then
    echo
    echo "❌ Local validator did not become ready at $LOCALNET_URL"
    echo "   Last log lines:"
    tail -40 "$VALIDATOR_LOG" || true
    exit 1
  fi
fi

export ANCHOR_PROVIDER_URL="$LOCALNET_URL"
export ANCHOR_WALLET="$WALLET_PATH"
solana config set --url "$LOCALNET_URL" >/dev/null
solana config set --keypair "$WALLET_PATH" >/dev/null

WALLET_PUB="$(solana address -k "$WALLET_PATH")"
echo "Airdropping SOL to $WALLET_PUB..."
for _ in 1 2 3 4 5; do
  solana airdrop 100 "$WALLET_PUB" --url "$LOCALNET_URL" >/dev/null || true
  sleep 0.5
done
BAL="$(solana balance "$WALLET_PUB" --url "$LOCALNET_URL" | awk '{print $1}')"
echo "✓ Wallet balance: ${BAL} SOL"

POOL_PDA="$(node -e "
  const {PublicKey}=require('@solana/web3.js');
  const [pda]=PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity_pool')],
    new PublicKey(process.argv[1])
  );
  process.stdout.write(pda.toBase58());
" "$PROGRAM_ID")"

VALIDATOR_PID=""
if [[ -f "$VALIDATOR_PID_PATH" ]]; then
  VALIDATOR_PID="$(cat "$VALIDATOR_PID_PATH")"
fi

node -e "
const fs = require('fs');
const state = {
  cluster: 'localnet',
  rpcUrl: process.argv[1],
  walletPath: process.argv[2],
  programId: process.argv[3],
  programKeypairPath: process.argv[4],
  poolPda: process.argv[5],
  legacyCommit: process.argv[6],
  pinsPatched: true,
  validatorPid: process.argv[7] ? Number(process.argv[7]) : undefined,
  phase: '00-setup',
};
fs.writeFileSync(process.argv[8], JSON.stringify(state, null, 2) + '\n');
" "$LOCALNET_URL" "$WALLET_PATH" "$PROGRAM_ID" "$STABLE_PROGRAM_KEYPAIR" \
  "$POOL_PDA" "$LEGACY_COMMIT" "$VALIDATOR_PID" "$STATE_PATH"

echo
echo "✓ Wrote state: $STATE_PATH"
echo "  Program ID: $PROGRAM_ID"
echo "  Pool PDA:   $POOL_PDA"
echo
echo "Next: bash scripts/migration-verify/01-build-deploy-legacy.sh"
