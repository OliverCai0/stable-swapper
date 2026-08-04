import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** Absolute path to the `solana/` package root (contains Anchor.toml). */
export const SOLANA_DIR = path.resolve(__dirname, "../../..");

export const VERIFY_DIR = path.join(SOLANA_DIR, ".migration-verify");
export const KEYS_DIR = path.join(VERIFY_DIR, "keys");
export const ARTIFACTS_LEGACY_DIR = path.join(
  VERIFY_DIR,
  "artifacts",
  "legacy"
);
export const ARTIFACTS_CURRENT_DIR = path.join(
  VERIFY_DIR,
  "artifacts",
  "current"
);
export const LEGACY_WORKTREE = path.join(VERIFY_DIR, "legacy-worktree");
export const LEDGER_DIR = path.join(VERIFY_DIR, "test-ledger");
export const VALIDATOR_PID_PATH = path.join(VERIFY_DIR, "validator.pid");
export const PROGRAM_KEYPAIR_PATH = path.join(
  SOLANA_DIR,
  "target",
  "deploy",
  "scaas_liquidity-keypair.json"
);
export const LIB_RS_PATH = path.join(
  SOLANA_DIR,
  "programs",
  "scaas-liquidity",
  "src",
  "lib.rs"
);
export const ANCHOR_TOML_PATH = path.join(SOLANA_DIR, "Anchor.toml");

export const LEGACY_COMMIT = "3f5b5d8";
export const LEGACY_POOL_SIZE = 1719;
export const NEW_POOL_SIZE = 2107;
export const LOCALNET_URL = "http://127.0.0.1:8899";
export const DEVNET_URL = "https://api.devnet.solana.com";

export type VerifyCluster = "localnet" | "devnet";

/** Resolve which cluster this run targets. */
export function resolveCluster(
  explicit?: string | null
): VerifyCluster {
  const fromEnv = (explicit || process.env.MIGRATION_VERIFY_CLUSTER || "")
    .trim()
    .toLowerCase();
  if (fromEnv === "devnet" || fromEnv === "localnet") {
    return fromEnv;
  }
  const devnetState = path.join(VERIFY_DIR, "devnet-state.json");
  const localnetState = path.join(VERIFY_DIR, "localnet-state.json");
  if (fs.existsSync(devnetState) && !fs.existsSync(localnetState)) {
    return "devnet";
  }
  return "localnet";
}

export function statePathFor(cluster: VerifyCluster): string {
  return path.join(VERIFY_DIR, `${cluster}-state.json`);
}

export function stableProgramKeypairPath(cluster: VerifyCluster): string {
  return path.join(KEYS_DIR, `${cluster}-program-keypair.json`);
}

export function rpcUrlFor(cluster: VerifyCluster): string {
  return cluster === "devnet" ? DEVNET_URL : LOCALNET_URL;
}

/** @deprecated Prefer statePathFor(resolveCluster()). Kept for call-site migration. */
export function getStatePath(): string {
  return statePathFor(resolveCluster());
}

export function defaultWalletPath(): string {
  return (
    process.env.ANCHOR_WALLET ||
    path.join(os.homedir(), ".config", "solana", "id.json")
  );
}

export function ensureVerifyDirs(): void {
  for (const dir of [
    VERIFY_DIR,
    KEYS_DIR,
    ARTIFACTS_LEGACY_DIR,
    ARTIFACTS_CURRENT_DIR,
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}
