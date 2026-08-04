# Migration Verification (localnet + devnet)

Companion scripts for the Solana fine-grained RBAC change. The rest of this
branch matches the RBAC program/tests branch; this directory is the only
addition. Reviewers can run the phases below to see how upgrade +
`migrate_authorities` artifacts are produced end-to-end.

Phased scripts that exercise the real upgrade-then-migrate path:

1. Deploy the **pre-RBAC** program (git commit `4c287f3` — Initial Commit)
2. Create a legacy pool, add tokens, fund vaults, swap
3. Upgrade to the **current** program binary
4. Run `migrate_authorities`
5. Smoke-test the new role authorities and swap again

An ephemeral program keypair is generated under `.migration-verify/keys/`.
Committed pins (`declare_id!`, `[programs.localnet]` / `[programs.devnet]`) are
patched for the run and restored by cleanup. **Never** use these scripts against
the pinned shared deployments unless you intentionally set that keypair.

Set the cluster for every phase:

```bash
export MIGRATION_VERIFY_CLUSTER=localnet   # or devnet
```

If unset, scripts prefer `devnet-state.json` when it exists alone; otherwise
`localnet`.

---

## Localnet

### Prerequisites

- `anchor` 0.31.1+, `node`, `yarn`
- Agave **3.1.10** CLI (deploy/upgrade) and **2.1.0** SBF tools (program builds)
- Wallet at `~/.config/solana/id.json` (airdropped automatically)

```bash
# Runtime / upgrades
sh -c "$(curl -sSfL https://release.anza.xyz/v3.1.10/install)"
# SBF compiler (avoid Swap stack faults from 3.1.x platform-tools)
sh -c "$(curl -sSfL https://release.anza.xyz/v2.1.0/install)"
"$HOME/.local/share/solana/install/releases/3.1.10/solana-release/bin/agave-install" init 3.1.10

cd solana
yarn install --frozen-lockfile
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export MIGRATION_VERIFY_CLUSTER=localnet
```

### Run order

```bash
bash scripts/migration-verify/00-setup-localnet.sh
bash scripts/migration-verify/01-build-deploy-legacy.sh
yarn ts-node scripts/migration-verify/02-seed-legacy-pool.ts
bash scripts/migration-verify/03-upgrade-to-current.sh
yarn ts-node scripts/migration-verify/04-migrate.ts
yarn ts-node scripts/migration-verify/05-smoke-authorities.ts
bash scripts/migration-verify/06-cleanup.sh
# bash scripts/migration-verify/06-cleanup.sh --purge
```

State: `.migration-verify/localnet-state.json`

---

## Devnet

Same phases against `https://api.devnet.solana.com` with a **throwaway** program
ID (not the pinned `9vDw…`).

### Prerequisites

- Solana CLI **2.2.21+** (used for both CLI and SBF builds)
- Anchor CLI **0.31.1+**
- SPL Token CLI **5.3.0+**
- A wallet with enough SOL (~3+ for program deploy); faucet may rate-limit

```bash
sh -c "$(curl -sSfL https://release.anza.xyz/v2.2.21/install)"
# If another install overwrote active_release, re-pin:
"$HOME/.local/share/solana/install/releases/2.2.21/solana-release/bin/agave-install" init 2.2.21

cd solana
yarn install --frozen-lockfile
export ANCHOR_WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
export MIGRATION_VERIFY_CLUSTER=devnet
# Critical: without this, many ad-hoc scripts default to MAINNET
export ANCHOR_PROVIDER_URL="https://api.devnet.solana.com"
```

Override toolchain if needed:

```bash
export MIGRATION_VERIFY_SOLANA_VERSION=2.2.21
export MIGRATION_VERIFY_SBF_BUILD_VERSION=2.2.21
# Fallback if Swap stack-faults: SBF 2.1.0 + CLI 2.2.21
# export MIGRATION_VERIFY_SBF_BUILD_VERSION=2.1.0
```

### Run order

```bash
export MIGRATION_VERIFY_CLUSTER=devnet
bash scripts/migration-verify/00-setup-devnet.sh
bash scripts/migration-verify/01-build-deploy-legacy.sh
yarn ts-node scripts/migration-verify/02-seed-legacy-pool.ts
bash scripts/migration-verify/03-upgrade-to-current.sh
yarn ts-node scripts/migration-verify/04-migrate.ts
yarn ts-node scripts/migration-verify/05-smoke-authorities.ts
bash scripts/migration-verify/06-cleanup.sh
```

State: `.migration-verify/devnet-state.json`

Explorer (replace with your ephemeral program ID from state):

```text
https://explorer.solana.com/address/<PROGRAM_ID>?cluster=devnet
```

Cleanup restores git pins only; the ephemeral program stays on-chain. Optional:

```bash
solana program close <PROGRAM_ID> --url https://api.devnet.solana.com --bypass-warning
```

---

## If a phase fails mid-run

`declare_id!` and the matching `[programs.*]` entry may still be patched:

```bash
bash scripts/migration-verify/06-cleanup.sh
# or:
git checkout -- programs/stable-swapper/src/lib.rs Anchor.toml
```

If `yarn ts-node` is unavailable, use `./node_modules/.bin/ts-node`.

## Out of scope

- Touching the pinned shared `9vDw…` / mainnet deployments
- CI wiring
- Authority self-rotation smoke
