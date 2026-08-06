#!/usr/bin/env bash
# Phase 00 (devnet): ephemeral program ID, faucet airdrop, state file.
# Never touches the pinned programs.devnet ID permanently — cleanup restores pins.
set -euo pipefail

export MIGRATION_VERIFY_CLUSTER=devnet
source "$(cd "$(dirname "$0")" && pwd)/lib/common.sh"
ensure_dirs

WALLET_PATH="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
if [[ ! -f "$WALLET_PATH" ]]; then
  echo "❌ Wallet not found at $WALLET_PATH"
  echo "   Create one with: solana-keygen new -o $WALLET_PATH"
  exit 1
fi

banner "00 — SETUP DEVNET MIGRATION VERIFY" \
  "throwaway program ID, funded wallet, devnet state file"
echo "- Solana dir: $SOLANA_DIR"
echo "- Wallet:     $WALLET_PATH"
echo "- RPC:        $DEVNET_URL"
echo "- CLI pin:    $MIGRATION_VERIFY_SOLANA_VERSION"
echo
echo "⚠️  Scripts default to MAINNET if ANCHOR_PROVIDER_URL is unset."
echo "   This setup forces: $DEVNET_URL"
echo

# Ephemeral program keypair (stable path + deploy copy).
solana-keygen new --no-bip39-passphrase --silent --force \
  --outfile "$STABLE_PROGRAM_KEYPAIR"
cp "$STABLE_PROGRAM_KEYPAIR" "$DEPLOY_KEYPAIR"
PROGRAM_ID="$(solana address -k "$STABLE_PROGRAM_KEYPAIR")"
say_ok "Ephemeral program ID: $PROGRAM_ID"
echo "  (pinned 9vDw… is NOT used)"

# Patch declare_id! + [programs.devnet] only.
patch_program_id "$LIB_RS" "$ANCHOR_TOML" "$PROGRAM_ID" "devnet"
say_ok "Patched declare_id! and [programs.devnet]"

export ANCHOR_PROVIDER_URL="$DEVNET_URL"
export ANCHOR_WALLET="$WALLET_PATH"
solana config set --url "$DEVNET_URL" >/dev/null
solana config set --keypair "$WALLET_PATH" >/dev/null

if ! rpc_up "$DEVNET_URL"; then
  echo "❌ Cannot reach $DEVNET_URL"
  exit 1
fi
say_ok "Devnet RPC reachable"

WALLET_PUB="$(solana address -k "$WALLET_PATH")"
echo "Airdropping SOL to $WALLET_PUB (faucet may rate-limit)..."
for amt in 2 2 2 1 1; do
  solana airdrop "$amt" "$WALLET_PUB" --url "$DEVNET_URL" >/dev/null 2>&1 || true
  sleep 1
done
BAL="$(solana balance "$WALLET_PUB" --url "$DEVNET_URL" | awk '{print $1}')"
say_ok "Wallet balance: ${BAL} SOL"
# Need enough for program deploy + rent (~3+ SOL typically for large .so).
NEED_MIN=3
awk -v bal="$BAL" -v need="$NEED_MIN" 'BEGIN { exit !(bal+0 >= need) }' || {
  echo "❌ Wallet has only ${BAL} SOL; need at least ~${NEED_MIN} SOL for deploy."
  echo "   Top up via https://faucet.solana.com or retry airdrops, then re-run setup."
  exit 1
}

POOL_PDA="$(node -e "
  const {PublicKey}=require('@solana/web3.js');
  const [pda]=PublicKey.findProgramAddressSync(
    [Buffer.from('liquidity_pool')],
    new PublicKey(process.argv[1])
  );
  process.stdout.write(pda.toBase58());
" "$PROGRAM_ID")"

node -e "
const fs = require('fs');
const state = {
  cluster: 'devnet',
  rpcUrl: process.argv[1],
  walletPath: process.argv[2],
  programId: process.argv[3],
  programKeypairPath: process.argv[4],
  poolPda: process.argv[5],
  legacyCommit: process.argv[6],
  pinsPatched: true,
  phase: '00-setup',
};
fs.writeFileSync(process.argv[7], JSON.stringify(state, null, 2) + '\n');
" "$DEVNET_URL" "$WALLET_PATH" "$PROGRAM_ID" "$STABLE_PROGRAM_KEYPAIR" \
  "$POOL_PDA" "$LEGACY_COMMIT" "$STATE_PATH"

echo
say_ok "Wrote state: $STATE_PATH"
echo "  Program ID: $PROGRAM_ID"
echo "  Pool PDA:   $POOL_PDA"
echo "  Explorer:   https://explorer.solana.com/address/${PROGRAM_ID}?cluster=devnet"
echo
echo "Next:"
echo "  export MIGRATION_VERIFY_CLUSTER=devnet"
echo "  bash scripts/migration-verify/01-build-deploy-legacy.sh"
