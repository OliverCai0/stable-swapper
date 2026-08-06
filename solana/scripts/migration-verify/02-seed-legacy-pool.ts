/**
 * Phase 02: initialize a legacy pool against the pre-RBAC IDL, mint two tokens,
 * fund vaults via SPL transfer, assert size 1719, and run a pre-upgrade swap.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  createMint,
  createAssociatedTokenAccount,
  getAssociatedTokenAddress,
  getAccount,
  mintTo,
  transfer,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as path from "path";
import {
  ARTIFACTS_LEGACY_DIR,
  KEYS_DIR,
  LEGACY_POOL_SIZE,
  ensureVerifyDirs,
} from "./lib/paths";
import { loadState, updateState } from "./lib/state";
import {
  assertPoolSize,
  loadIdl,
  makeProgram,
  makeProvider,
  poolPda,
  vaultPdas,
  writeKeypair,
} from "./lib/common";
import * as ui from "./lib/ui";

const DECIMALS = 6;
const FEE_RATE_BPS = 0;
const VAULT_FUND_TOKENS = 1_000;
const SWAP_TOKENS = 10;
const USER_MINT_TOKENS = 10_000;

async function main() {
  ensureVerifyDirs();
  const state = loadState();
  const { provider, connection, payer } = makeProvider(state);
  const programId = new PublicKey(state.programId);
  const pool = poolPda(programId);

  const idlPath = path.join(ARTIFACTS_LEGACY_DIR, "stable_swapper.json");
  const idl = loadIdl(idlPath);
  const program = makeProgram(idl, provider, programId);

  ui.banner(
    "02 — SEED LEGACY POOL",
    "a real pre-RBAC pool with tokens, liquidity, and a swap"
  );
  ui.kv("Cluster", state.cluster);
  ui.kv("Program ID", programId.toBase58());
  ui.kv("Pool PDA", pool.toBase58());
  ui.kv("Wallet", payer.publicKey.toBase58());
  ui.blank();

  // --- Initialize (legacy layout: ops + pause + fee_recipient) ---
  const existing = await connection.getAccountInfo(pool);
  if (existing) {
    ui.info("Pool already exists; skipping initialize.");
  } else {
    ui.section("Initialize legacy pool");
    const tx = await program.methods
      .initialize(new anchor.BN(FEE_RATE_BPS))
      .accounts({
        pool,
        payer: payer.publicKey,
        operationsAuthority: payer.publicKey,
        pauseAuthority: payer.publicKey,
        feeRecipient: payer.publicKey,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
    ui.ok(`Initialized. Signature ${ui.color.dim(String(tx))}`);
  }

  await assertPoolSize(connection, pool, LEGACY_POOL_SIZE, "post-init");

  // --- Create two mints (or reuse from state) ---
  let mintA: PublicKey;
  let mintB: PublicKey;
  let mintAKp: Keypair;
  let mintBKp: Keypair;

  const mintAPath = path.join(KEYS_DIR, "mint-a.json");
  const mintBPath = path.join(KEYS_DIR, "mint-b.json");

  if (state.mintA && state.mintB) {
    mintA = new PublicKey(state.mintA);
    mintB = new PublicKey(state.mintB);
    ui.info("Reusing mints from state:");
    ui.note(`A ${mintA.toBase58()}`);
    ui.note(`B ${mintB.toBase58()}`);
  } else {
    ui.section("Create mints");
    mintAKp = Keypair.generate();
    mintBKp = Keypair.generate();
    writeKeypair(mintAPath, mintAKp);
    writeKeypair(mintBPath, mintBKp);

    mintA = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      DECIMALS,
      mintAKp
    );
    mintB = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      DECIMALS,
      mintBKp
    );
    ui.ok(`Mint A ${ui.color.dim(String(mintA.toBase58()))}`);
    ui.ok(`Mint B ${ui.color.dim(String(mintB.toBase58()))}`);
  }

  const userAtaA = await getOrCreateAta(
    connection,
    payer,
    mintA,
    payer.publicKey
  );
  const userAtaB = await getOrCreateAta(
    connection,
    payer,
    mintB,
    payer.publicKey
  );

  const units = (n: number) => BigInt(n) * BigInt(10 ** DECIMALS);
  await mintTo(
    connection,
    payer,
    mintA,
    userAtaA,
    payer,
    units(USER_MINT_TOKENS)
  );
  await mintTo(
    connection,
    payer,
    mintB,
    userAtaB,
    payer,
    units(USER_MINT_TOKENS)
  );
  ui.ok(`Minted ${USER_MINT_TOKENS} of each token to wallet ATAs`);

  // --- Add supported tokens (legacy: operations_authority) ---
  for (const mint of [mintA, mintB]) {
    await addTokenIfNeeded(program, payer, pool, mint);
  }

  const { vaultTokenAccount: vaultAtaA } = vaultPdas(programId, pool, mintA);
  const { vaultTokenAccount: vaultAtaB } = vaultPdas(programId, pool, mintB);

  // --- Fund vaults via SPL transfer ---
  await fundVault(
    connection,
    payer,
    userAtaA,
    vaultAtaA,
    units(VAULT_FUND_TOKENS)
  );
  await fundVault(
    connection,
    payer,
    userAtaB,
    vaultAtaB,
    units(VAULT_FUND_TOKENS)
  );
  ui.ok(`Funded each vault with ${VAULT_FUND_TOKENS} tokens`);

  await assertPoolSize(connection, pool, LEGACY_POOL_SIZE, "pre-swap");

  // --- Pre-upgrade swap A -> B ---
  ui.section(`Pre-upgrade swap: ${SWAP_TOKENS} of A → B`);
  const amountIn = new anchor.BN((SWAP_TOKENS * 10 ** DECIMALS).toString());
  const minOut = new anchor.BN(
    (SWAP_TOKENS * 10 ** DECIMALS * 0.99).toString()
  );

  const { vault: inVault, vaultTokenAccount: inVaultAta } = vaultPdas(
    programId,
    pool,
    mintA
  );
  const { vault: outVault, vaultTokenAccount: outVaultAta } = vaultPdas(
    programId,
    pool,
    mintB
  );
  const feeRecipientAta = await getAssociatedTokenAddress(
    mintA,
    payer.publicKey
  );

  const balBefore = await getAccount(connection, userAtaB);
  const swapSig = await program.methods
    .swap(amountIn, minOut)
    .accounts({
      pool,
      inVault,
      outVault,
      inVaultTokenAccount: inVaultAta,
      outVaultTokenAccount: outVaultAta,
      userFromTokenAccount: userAtaA,
      toTokenAccount: userAtaB,
      feeRecipientTokenAccount: feeRecipientAta,
      feeRecipient: payer.publicKey,
      fromMint: mintA,
      toMint: mintB,
      user: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
  const balAfter = await getAccount(connection, userAtaB);
  const received = Number(balAfter.amount - balBefore.amount) / 10 ** DECIMALS;
  ui.ok(`Pre-upgrade swap ok. Signature ${ui.color.dim(String(swapSig))}`);
  ui.note(`received ~${received} of mint B`);

  await assertPoolSize(connection, pool, LEGACY_POOL_SIZE, "post-swap");

  updateState({
    poolPda: pool.toBase58(),
    mintA: mintA.toBase58(),
    mintB: mintB.toBase58(),
    mintAKeypairPath: mintAPath,
    mintBKeypairPath: mintBPath,
    vaultTokenAccountA: vaultAtaA.toBase58(),
    vaultTokenAccountB: vaultAtaB.toBase58(),
    feeRateBps: FEE_RATE_BPS,
    preSwapSignature: swapSig,
    legacyOpsAuthority: payer.publicKey.toBase58(),
    legacyPauseAuthority: payer.publicKey.toBase58(),
    feeRecipient: payer.publicKey.toBase58(),
    phase: "02-seeded",
  });

  console.log();
  ui.ok("Legacy pool seeded. State updated.");
  ui.note("Next: bash scripts/migration-verify/03-upgrade-to-current.sh");
}

async function getOrCreateAta(
  connection: anchor.web3.Connection,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner);
  try {
    await getAccount(connection, ata);
    return ata;
  } catch {
    return createAssociatedTokenAccount(connection, payer, mint, owner);
  }
}

async function addTokenIfNeeded(
  program: anchor.Program,
  payer: Keypair,
  pool: PublicKey,
  mint: PublicKey
): Promise<void> {
  const programId = program.programId;
  const poolAccount: any = await (program.account as any).liquidityPool.fetch(
    pool
  );
  const already = (poolAccount.supportedTokens as PublicKey[]).some((t) =>
    t.equals(mint)
  );
  if (already) {
    ui.info(`Token already supported: ${mint.toBase58()}`);
    return;
  }

  const { vault, vaultTokenAccount } = vaultPdas(programId, pool, mint);
  const feeRecipientAta = await getAssociatedTokenAddress(
    mint,
    payer.publicKey
  );

  ui.info(`adding supported token ${mint.toBase58()}`);
  const tx = await program.methods
    .addSupportedToken()
    .accounts({
      pool,
      vault,
      vaultTokenAccount,
      feeRecipientTokenAccount: feeRecipientAta,
      feeRecipient: payer.publicKey,
      mint,
      operationsAuthority: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    } as any)
    .rpc();
  ui.ok(`Added. Signature ${ui.color.dim(String(tx))}`);
}

async function fundVault(
  connection: anchor.web3.Connection,
  payer: Keypair,
  fromAta: PublicKey,
  vaultAta: PublicKey,
  amount: bigint
): Promise<void> {
  const vaultInfo = await getAccount(connection, vaultAta);
  if (vaultInfo.amount >= amount) {
    console.log(
      `ℹ️  Vault ${vaultAta.toBase58()} already funded (>= ${amount})`
    );
    return;
  }
  const need = amount - vaultInfo.amount;
  await transfer(connection, payer, fromAta, vaultAta, payer, need);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
