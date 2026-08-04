import * as fs from "fs";
import {
  ensureVerifyDirs,
  resolveCluster,
  statePathFor,
  rpcUrlFor,
  defaultWalletPath,
  VerifyCluster,
} from "./paths";

export interface RoleKeyPaths {
  pause: string;
  unpause: string;
  treasury: string;
  configure: string;
  withdrawRecipient: string;
  stranger: string;
}

export interface VerifyState {
  cluster: VerifyCluster;
  rpcUrl: string;
  walletPath: string;
  programId: string;
  programKeypairPath: string;
  poolPda?: string;
  legacyCommit?: string;
  pinsPatched?: boolean;
  validatorPid?: number;
  mintA?: string;
  mintB?: string;
  mintAKeypairPath?: string;
  mintBKeypairPath?: string;
  vaultTokenAccountA?: string;
  vaultTokenAccountB?: string;
  feeRateBps?: number;
  preSwapSignature?: string;
  migrateSignature?: string;
  /** Captured txs from 05-smoke-authorities.ts (null = expected sim failure / no land). */
  smokeSignatures?: SmokeSignatures;
  roleKeyPaths?: RoleKeyPaths;
  legacyOpsAuthority?: string;
  legacyPauseAuthority?: string;
  feeRecipient?: string;
  phase?: string;
}

export interface SmokeSignatures {
  pauseSwaps?: string | null;
  swapWhilePaused?: string | null;
  unpauseSwaps?: string | null;
  pauseWithdraws?: string | null;
  withdrawWhilePaused?: string | null;
  unpauseWithdraws?: string | null;
  treasuryWithdrawAllowlisted?: string | null;
  treasuryWithdrawDenyStranger?: string | null;
  addWithdrawRecipient?: string | null;
  removeWithdrawRecipient?: string | null;
  postMigrateSwap?: string | null;
}

/** @deprecated Use VerifyState */
export type LocalnetState = VerifyState;

function activeStatePath(): string {
  return statePathFor(resolveCluster());
}

export function loadState(): VerifyState {
  const statePath = activeStatePath();
  if (!fs.existsSync(statePath)) {
    throw new Error(
      `State file missing at ${statePath}. Run 00-setup-localnet.sh or 00-setup-devnet.sh first ` +
        `(or set MIGRATION_VERIFY_CLUSTER=localnet|devnet).`
    );
  }
  return JSON.parse(fs.readFileSync(statePath, "utf8")) as VerifyState;
}

export function saveState(state: VerifyState): void {
  ensureVerifyDirs();
  const statePath = statePathFor(state.cluster);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n");
}

export function updateState(patch: Partial<VerifyState>): VerifyState {
  const cluster = (patch.cluster as VerifyCluster) || resolveCluster();
  const statePath = statePathFor(cluster);
  const current = fs.existsSync(statePath)
    ? (JSON.parse(fs.readFileSync(statePath, "utf8")) as VerifyState)
    : ({
        cluster,
        rpcUrl: rpcUrlFor(cluster),
        walletPath: defaultWalletPath(),
        programId: "",
        programKeypairPath: "",
      } as VerifyState);
  const next = { ...current, ...patch, cluster: current.cluster || cluster };
  saveState(next);
  return next;
}

export function applyClusterEnv(state?: VerifyState): VerifyState {
  const s = state ?? loadState();
  process.env.ANCHOR_PROVIDER_URL = s.rpcUrl;
  process.env.ANCHOR_WALLET = s.walletPath;
  process.env.MIGRATION_VERIFY_CLUSTER = s.cluster;
  return s;
}

/** @deprecated Use applyClusterEnv */
export function applyLocalnetEnv(state?: VerifyState): VerifyState {
  return applyClusterEnv(state);
}
