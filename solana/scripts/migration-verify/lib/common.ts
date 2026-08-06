import * as anchor from "@coral-xyz/anchor";
import { Program, Idl } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import { VerifyState, applyClusterEnv } from "./state";
import * as ui from "./ui";

export function readKeypair(filePath: string): Keypair {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as number[];
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

export function writeKeypair(filePath: string, keypair: Keypair): void {
  fs.writeFileSync(
    filePath,
    JSON.stringify(Array.from(keypair.secretKey)) + "\n"
  );
}

export function loadWalletKeypair(walletPath: string): Keypair {
  return readKeypair(walletPath);
}

export const BPF_LOADER_UPGRADEABLE_PROGRAM_ID = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

export function programDataAddress(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [programId.toBuffer()],
    BPF_LOADER_UPGRADEABLE_PROGRAM_ID
  )[0];
}

/**
 * Read `upgrade_authority_address` out of a deployed program's ProgramData.
 * Layout is bincode: 4-byte enum tag, 8-byte slot, 1-byte Option tag, 32-byte pubkey.
 * Returns null when the program is immutable or ProgramData is missing.
 */
export async function readUpgradeAuthority(
  connection: Connection,
  programId: PublicKey
): Promise<PublicKey | null> {
  const info = await connection.getAccountInfo(programDataAddress(programId));
  if (!info || info.data.length < 45) return null;
  if (info.data[12] !== 1) return null;
  return new PublicKey(info.data.subarray(13, 45));
}

export function poolPda(programId: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("liquidity_pool")],
    programId
  )[0];
}

export function vaultPdas(
  programId: PublicKey,
  pool: PublicKey,
  mint: PublicKey
): { vault: PublicKey; vaultTokenAccount: PublicKey } {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault"), pool.toBuffer(), mint.toBuffer()],
    programId
  );
  const [vaultTokenAccount] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_token_account"), vault.toBuffer()],
    programId
  );
  return { vault, vaultTokenAccount };
}

export async function assertPoolSize(
  connection: Connection,
  pool: PublicKey,
  expected: number,
  label: string
): Promise<void> {
  const info = await connection.getAccountInfo(pool);
  if (!info) {
    throw new Error(`${label}: pool account ${pool.toBase58()} does not exist`);
  }
  if (info.data.length !== expected) {
    throw new Error(
      `${label}: pool size is ${info.data.length}, expected ${expected}`
    );
  }
  ui.ok(
    `${label}: pool size is ${ui.color.bold(String(info.data.length))} bytes`
  );
}

export function loadIdl(idlPath: string): Idl {
  if (!fs.existsSync(idlPath)) {
    throw new Error(`IDL not found at ${idlPath}`);
  }
  return JSON.parse(fs.readFileSync(idlPath, "utf8")) as Idl;
}

export function makeProvider(state: VerifyState): {
  provider: anchor.AnchorProvider;
  connection: Connection;
  payer: Keypair;
  wallet: anchor.Wallet;
} {
  applyClusterEnv(state);
  const payer = loadWalletKeypair(state.walletPath);
  const connection = new Connection(state.rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(payer);
  const provider = new anchor.AnchorProvider(connection, wallet, {
    commitment: "confirmed",
    preflightCommitment: "confirmed",
  });
  anchor.setProvider(provider);
  return { provider, connection, payer, wallet };
}

/** Loose Program typing — migration-verify loads IDL from JSON files at runtime. */
export function makeProgram(
  idl: Idl,
  provider: anchor.AnchorProvider,
  programId?: PublicKey
): Program {
  const idlWithAddress = {
    ...idl,
    address: programId?.toBase58() ?? (idl as any).address,
  };
  return new Program(idlWithAddress as Idl, provider);
}

export async function airdropIfNeeded(
  connection: Connection,
  pubkey: PublicKey,
  minSol = 50
): Promise<void> {
  const balance = await connection.getBalance(pubkey);
  const minLamports = minSol * anchor.web3.LAMPORTS_PER_SOL;
  if (balance >= minLamports) {
    console.log(
      `✓ Wallet ${pubkey.toBase58()} has ${(
        balance / anchor.web3.LAMPORTS_PER_SOL
      ).toFixed(2)} SOL`
    );
    return;
  }
  const need = minLamports - balance;
  console.log(
    `Airdropping ~${(need / anchor.web3.LAMPORTS_PER_SOL).toFixed(
      2
    )} SOL to ${pubkey.toBase58()}...`
  );
  const sig = await connection.requestAirdrop(pubkey, need);
  await connection.confirmTransaction(sig, "confirmed");
}

export async function fundKeypair(
  connection: Connection,
  funder: Keypair,
  recipient: PublicKey,
  sol = 2
): Promise<void> {
  const balance = await connection.getBalance(recipient);
  const target = sol * anchor.web3.LAMPORTS_PER_SOL;
  if (balance >= target) return;
  const tx = new Transaction().add(
    SystemProgram.transfer({
      fromPubkey: funder.publicKey,
      toPubkey: recipient,
      lamports: target - balance,
    })
  );
  await sendAndConfirmTransaction(connection, tx, [funder]);
}

export function errText(error: unknown): string {
  const e = error as { logs?: string[]; transactionMessage?: string };
  const logs = Array.isArray(e?.logs) ? e.logs.join("\n") : "";
  return `${logs}\n${e?.transactionMessage ?? ""}\n${error}`.toLowerCase();
}
