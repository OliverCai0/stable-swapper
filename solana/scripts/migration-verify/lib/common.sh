#!/usr/bin/env bash
# Shared helpers for migration-verify shell phases.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034
MV_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SOLANA_DIR="$(cd "$MV_DIR/../.." && pwd)"
REPO_ROOT="$(cd "$SOLANA_DIR/.." && pwd)"

VERIFY_DIR="$SOLANA_DIR/.migration-verify"
KEYS_DIR="$VERIFY_DIR/keys"
ARTIFACTS_LEGACY="$VERIFY_DIR/artifacts/legacy"
ARTIFACTS_CURRENT="$VERIFY_DIR/artifacts/current"
LEGACY_WORKTREE="$VERIFY_DIR/legacy-worktree"
LEDGER_DIR="$VERIFY_DIR/test-ledger"
VALIDATOR_PID_PATH="$VERIFY_DIR/validator.pid"
DEPLOY_KEYPAIR="$SOLANA_DIR/target/deploy/stable_swapper-keypair.json"
LIB_RS="$SOLANA_DIR/programs/stable-swapper/src/lib.rs"
ANCHOR_TOML="$SOLANA_DIR/Anchor.toml"
LEGACY_COMMIT="4c287f3"
LOCALNET_URL="http://127.0.0.1:8899"
DEVNET_URL="https://api.devnet.solana.com"
SOLANA_RELEASES_DIR="${HOME}/.local/share/solana/install/releases"

# Resolve cluster: explicit env, else prefer sole existing state file, else localnet.
resolve_cluster() {
  local c="${MIGRATION_VERIFY_CLUSTER:-}"
  c="$(echo "$c" | tr '[:upper:]' '[:lower:]')"
  if [[ "$c" == "devnet" || "$c" == "localnet" ]]; then
    echo "$c"
    return
  fi
  if [[ -f "$VERIFY_DIR/devnet-state.json" && ! -f "$VERIFY_DIR/localnet-state.json" ]]; then
    echo "devnet"
    return
  fi
  echo "localnet"
}

MIGRATION_VERIFY_CLUSTER="$(resolve_cluster)"
export MIGRATION_VERIFY_CLUSTER
STATE_PATH="$VERIFY_DIR/${MIGRATION_VERIFY_CLUSTER}-state.json"
STABLE_PROGRAM_KEYPAIR="$KEYS_DIR/${MIGRATION_VERIFY_CLUSTER}-program-keypair.json"
# Compat alias used by existing phase scripts.
PROGRAM_KEYPAIR="$DEPLOY_KEYPAIR"

if [[ "$MIGRATION_VERIFY_CLUSTER" == "devnet" ]]; then
  CLUSTER_RPC_URL="$DEVNET_URL"
  ANCHOR_PROGRAMS_SECTION="devnet"
  # Runbook-tested toolchain for both CLI and SBF builds.
  DEFAULT_CLI_VERSION="2.2.21"
  DEFAULT_SBF_VERSION="2.2.21"
else
  CLUSTER_RPC_URL="$LOCALNET_URL"
  ANCHOR_PROGRAMS_SECTION="localnet"
  DEFAULT_CLI_VERSION="3.1.10"
  DEFAULT_SBF_VERSION="2.1.0"
fi

MIGRATION_VERIFY_SOLANA_VERSION="${MIGRATION_VERIFY_SOLANA_VERSION:-$DEFAULT_CLI_VERSION}"
MIGRATION_VERIFY_SBF_BUILD_VERSION="${MIGRATION_VERIFY_SBF_BUILD_VERSION:-$DEFAULT_SBF_VERSION}"

pin_solana_cli() {
  local bin_dir=""
  if [[ -n "${MIGRATION_VERIFY_SOLANA_BIN:-}" ]]; then
    bin_dir="$MIGRATION_VERIFY_SOLANA_BIN"
  elif [[ -d "$SOLANA_RELEASES_DIR/$MIGRATION_VERIFY_SOLANA_VERSION/solana-release/bin" ]]; then
    bin_dir="$SOLANA_RELEASES_DIR/$MIGRATION_VERIFY_SOLANA_VERSION/solana-release/bin"
  elif [[ -d "$HOME/.local/share/solana/install/active_release/bin" ]]; then
    bin_dir="$HOME/.local/share/solana/install/active_release/bin"
  fi

  if [[ -n "$bin_dir" ]]; then
    export PATH="$bin_dir:$PATH"
  fi

  if ! command -v solana >/dev/null 2>&1; then
    echo "❌ solana CLI not found on PATH"
    echo "   Install Agave ${MIGRATION_VERIFY_SOLANA_VERSION}:"
    echo "   sh -c \"\$(curl -sSfL https://release.anza.xyz/v${MIGRATION_VERIFY_SOLANA_VERSION}/install)\""
    exit 1
  fi

  local ver
  ver="$(solana --version 2>/dev/null || true)"
  echo "Cluster:  $MIGRATION_VERIFY_CLUSTER"
  echo "Using $(command -v solana)"
  echo "  $ver"
  if [[ "$MIGRATION_VERIFY_CLUSTER" == "localnet" && "$ver" == *" 2.1."* ]]; then
    echo "⚠️  Solana 2.1.x hits ExtendProgram/ExtendProgramChecked upgrade failures on localnet."
    echo "   Prefer CLI 3.1.10+ (MIGRATION_VERIFY_SOLANA_VERSION=3.1.10)."
  fi
}

pin_solana_cli

sbf_build_bin_dir() {
  local ver="${1:-$MIGRATION_VERIFY_SBF_BUILD_VERSION}"
  local bin="$SOLANA_RELEASES_DIR/$ver/solana-release/bin"
  if [[ ! -d "$bin" ]]; then
    echo "❌ SBF build toolchain $ver not found at: $bin" >&2
    echo "   Install with:" >&2
    echo "   sh -c \"\$(curl -sSfL https://release.anza.xyz/v${ver}/install)\"" >&2
    return 1
  fi
  printf '%s' "$bin"
}

anchor_build_with_sbf_toolchain() {
  local build_dir="$1"
  local bin_dir
  bin_dir="$(sbf_build_bin_dir)" || exit 1
  echo "Building with SBF toolchain $MIGRATION_VERIFY_SBF_BUILD_VERSION ($bin_dir)"
  (
    cd "$build_dir"
    PATH="$bin_dir:$PATH" anchor build
  )
}

ensure_dirs() {
  mkdir -p "$VERIFY_DIR" "$KEYS_DIR" "$ARTIFACTS_LEGACY" "$ARTIFACTS_CURRENT" \
    "$SOLANA_DIR/target/deploy"
}

sync_program_keypair_to_deploy() {
  if [[ ! -f "$STABLE_PROGRAM_KEYPAIR" ]]; then
    echo "❌ Missing stable program keypair: $STABLE_PROGRAM_KEYPAIR"
    echo "   Run 00-setup-${MIGRATION_VERIFY_CLUSTER}.sh first."
    exit 1
  fi
  cp "$STABLE_PROGRAM_KEYPAIR" "$DEPLOY_KEYPAIR"
}

require_state() {
  if [[ ! -f "$STATE_PATH" ]]; then
    echo "❌ State file missing: $STATE_PATH"
    echo "   Run 00-setup-${MIGRATION_VERIFY_CLUSTER}.sh first"
    echo "   (or set MIGRATION_VERIFY_CLUSTER=localnet|devnet)."
    exit 1
  fi
}

state_get() {
  local key="$1"
  node -e "
    const s = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
    const v = s[process.argv[2]];
    if (v === undefined || v === null) process.exit(2);
    process.stdout.write(String(v));
  " "$STATE_PATH" "$key"
}

patch_program_id() {
  local target_lib="$1"
  local target_toml="$2"
  local program_id="$3"
  local section="${4:-$ANCHOR_PROGRAMS_SECTION}"

  perl -pi -e "s/declare_id!\\(\"[^\"]+\"\\)/declare_id!(\"$program_id\")/" \
    "$target_lib"

  awk -v id="$program_id" -v sec="$section" '
    BEGIN { section_re = "^\\[programs\\." sec "\\]$" }
    /^\[/  { in_sec = ($0 ~ section_re) }
    in_sec && /^stable_swapper[[:space:]]*=/ {
      print "stable_swapper = \"" id "\""; next
    }
    { print }
  ' "$target_toml" > "$target_toml.tmp" && mv "$target_toml.tmp" "$target_toml"
}

export_cluster_env() {
  require_state
  local wallet rpc
  wallet="$(state_get walletPath)"
  rpc="$(state_get rpcUrl)"
  export ANCHOR_PROVIDER_URL="$rpc"
  export ANCHOR_WALLET="$wallet"
  solana config set --url "$rpc" >/dev/null
  solana config set --keypair "$wallet" >/dev/null
}

# Back-compat alias
export_localnet_env() {
  export_cluster_env
}

rpc_up() {
  local url="${1:-$CLUSTER_RPC_URL}"
  solana cluster-version --url "$url" >/dev/null 2>&1
}

cluster_rpc_url() {
  if [[ -f "$STATE_PATH" ]]; then
    state_get rpcUrl 2>/dev/null || echo "$CLUSTER_RPC_URL"
  else
    echo "$CLUSTER_RPC_URL"
  fi
}
