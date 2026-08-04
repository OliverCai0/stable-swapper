/**
 * Phase 05: full role smoke (runbook M5) + post-migrate swap on the migrated pool.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import * as path from "path";
import {
  ARTIFACTS_CURRENT_DIR,
  NEW_POOL_SIZE,
  ensureVerifyDirs,
} from "./lib/paths";
import { loadState, updateState, SmokeSignatures } from "./lib/state";
import {
  assertPoolSize,
  errText,
  loadIdl,
  makeProgram,
  makeProvider,
  poolPda,
  readKeypair,
  vaultPdas,
} from "./lib/common";

interface CheckResult {
  name: string;
  ok: boolean;
  detail?: string;
  signature?: string | null;
}

/** Prefer landed signature; Anchor sim failures usually have an empty signature. */
function txSig(error: unknown): string | null {
  const e = error as { signature?: string };
  return e?.signature ? e.signature : null;
}

async function main() {
  ensureVerifyDirs();
  const state = loadState();
  if (!state.roleKeyPaths || !state.mintA || !state.mintB) {
    throw new Error(
      "State incomplete — run 02-seed-legacy-pool.ts and 04-migrate.ts first."
    );
  }

  const { provider, connection, payer } = makeProvider(state);
  const programId = new PublicKey(state.programId);
  const pool = poolPda(programId);
  const idl = loadIdl(path.join(ARTIFACTS_CURRENT_DIR, "scaas_liquidity.json"));
  const program = makeProgram(idl, provider, programId);

  const pause = readKeypair(state.roleKeyPaths.pause);
  const unpause = readKeypair(state.roleKeyPaths.unpause);
  const treasury = readKeypair(state.roleKeyPaths.treasury);
  const configure = readKeypair(state.roleKeyPaths.configure);
  const withdrawRecipient = readKeypair(state.roleKeyPaths.withdrawRecipient);
  const stranger = readKeypair(state.roleKeyPaths.stranger);

  const mintA = new PublicKey(state.mintA);
  const mintB = new PublicKey(state.mintB);

  console.log("=".repeat(60));
  console.log("05 — AUTHORITY SMOKE + POST-MIGRATE SWAP");
  console.log("=".repeat(60));
  console.log("- Cluster:", state.cluster);
  console.log("- Program ID:", programId.toBase58());
  console.log("- Pool PDA:", pool.toBase58());
  console.log();

  await assertPoolSize(connection, pool, NEW_POOL_SIZE, "smoke start");

  const results: CheckResult[] = [];
  const smokeSignatures: SmokeSignatures = {};

  // Shared accounts for swap / withdraw checks.
  const recipientAta = await ensureAta(
    provider,
    payer,
    mintA,
    withdrawRecipient.publicKey
  );
  const strangerAta = await ensureAta(
    provider,
    payer,
    mintA,
    stranger.publicKey
  );
  const { vault, vaultTokenAccount } = vaultPdas(programId, pool, mintA);
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
  const userFrom = await getAssociatedTokenAddress(mintA, payer.publicKey);
  const userTo = await getAssociatedTokenAddress(mintB, payer.publicKey);
  const withdrawOne = new anchor.BN(1); // 1 base unit
  const swapAmountIn = new anchor.BN((1 * 10 ** 6).toString());
  const swapMinOut = new anchor.BN((1 * 10 ** 6 * 0.99).toString());

  async function doSwap(): Promise<string> {
    const poolAccount: any = await (program.account as any).liquidityPool.fetch(
      pool
    );
    const feeRecipientAta = await getAssociatedTokenAddress(
      mintA,
      poolAccount.feeRecipient
    );
    return program.methods
      .swap(swapAmountIn, swapMinOut)
      .accounts({
        pool,
        inVault,
        outVault,
        inVaultTokenAccount: inVaultAta,
        outVaultTokenAccount: outVaultAta,
        userFromTokenAccount: userFrom,
        toTokenAccount: userTo,
        feeRecipientTokenAccount: feeRecipientAta,
        feeRecipient: poolAccount.feeRecipient,
        fromMint: mintA,
        toMint: mintB,
        user: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  async function doWithdraw(recipientTokenAccount: PublicKey): Promise<string> {
    return program.methods
      .withdrawLiquidity(withdrawOne)
      .accounts({
        pool,
        vault,
        vaultTokenAccount,
        recipientTokenAccount,
        mint: mintA,
        treasuryAuthority: treasury.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([treasury])
      .rpc();
  }

  // --- Pause swaps: flag flips, swap rejected, then unpause ---
  try {
    const sig = await program.methods
      .pauseSwaps()
      .accounts({ pool, pauseAuthority: pause.publicKey } as any)
      .signers([pause])
      .rpc();
    smokeSignatures.pauseSwaps = sig;
    let acct: any = await (program.account as any).liquidityPool.fetch(pool);
    if (!acct.swapsPaused) throw new Error("swaps_paused still false");
    results.push({ name: "pause swaps (flag)", ok: true, signature: sig });
  } catch (e) {
    results.push({
      name: "pause swaps (flag)",
      ok: false,
      detail: String(e),
      signature: txSig(e),
    });
  }

  try {
    const sig = await doSwap();
    smokeSignatures.swapWhilePaused = sig;
    results.push({
      name: "swap while paused (deny)",
      ok: false,
      detail: "expected SwapsPaused but tx succeeded",
      signature: sig,
    });
  } catch (e) {
    const text = errText(e);
    const ok = text.includes("swapspaused") || text.includes("swaps paused");
    const sig = txSig(e);
    smokeSignatures.swapWhilePaused = sig;
    results.push({
      name: "swap while paused (deny)",
      ok,
      detail: ok ? undefined : text.slice(0, 400),
      signature: sig,
    });
  }

  try {
    const sig = await program.methods
      .unpauseSwaps()
      .accounts({ pool, unpauseAuthority: unpause.publicKey } as any)
      .signers([unpause])
      .rpc();
    smokeSignatures.unpauseSwaps = sig;
    const acct: any = await (program.account as any).liquidityPool.fetch(pool);
    if (acct.swapsPaused) throw new Error("swaps_paused still true");
    results.push({ name: "unpause swaps", ok: true, signature: sig });
  } catch (e) {
    results.push({
      name: "unpause swaps",
      ok: false,
      detail: String(e),
      signature: txSig(e),
    });
  }

  // --- Pause withdraws: flag flips, withdraw rejected, then unpause ---
  try {
    const sig = await program.methods
      .pauseWithdraws()
      .accounts({ pool, pauseAuthority: pause.publicKey } as any)
      .signers([pause])
      .rpc();
    smokeSignatures.pauseWithdraws = sig;
    let acct: any = await (program.account as any).liquidityPool.fetch(pool);
    if (!acct.liquidityPaused) throw new Error("liquidity_paused still false");
    results.push({ name: "pause withdraws (flag)", ok: true, signature: sig });
  } catch (e) {
    results.push({
      name: "pause withdraws (flag)",
      ok: false,
      detail: String(e),
      signature: txSig(e),
    });
  }

  try {
    const sig = await doWithdraw(recipientAta);
    smokeSignatures.withdrawWhilePaused = sig;
    results.push({
      name: "withdraw while paused (deny)",
      ok: false,
      detail: "expected LiquidityPaused but tx succeeded",
      signature: sig,
    });
  } catch (e) {
    const text = errText(e);
    const ok =
      text.includes("liquiditypaused") || text.includes("liquidity paused");
    const sig = txSig(e);
    smokeSignatures.withdrawWhilePaused = sig;
    results.push({
      name: "withdraw while paused (deny)",
      ok,
      detail: ok ? undefined : text.slice(0, 400),
      signature: sig,
    });
  }

  try {
    const sig = await program.methods
      .unpauseWithdraws()
      .accounts({ pool, unpauseAuthority: unpause.publicKey } as any)
      .signers([unpause])
      .rpc();
    smokeSignatures.unpauseWithdraws = sig;
    const acct: any = await (program.account as any).liquidityPool.fetch(pool);
    if (acct.liquidityPaused) throw new Error("liquidity_paused still true");
    results.push({ name: "unpause withdraws", ok: true, signature: sig });
  } catch (e) {
    results.push({
      name: "unpause withdraws",
      ok: false,
      detail: String(e),
      signature: txSig(e),
    });
  }

  // --- Treasury withdraw to allowlisted recipient ---
  try {
    const sig = await doWithdraw(recipientAta);
    smokeSignatures.treasuryWithdrawAllowlisted = sig;
    results.push({
      name: "treasury withdraw (allowlisted)",
      ok: true,
      signature: sig,
    });
  } catch (e) {
    results.push({
      name: "treasury withdraw (allowlisted)",
      ok: false,
      detail: String(e),
      signature: txSig(e),
    });
  }

  // --- Treasury withdraw to non-allowlisted owner must fail ---
  try {
    const sig = await doWithdraw(strangerAta);
    smokeSignatures.treasuryWithdrawDenyStranger = sig;
    results.push({
      name: "treasury withdraw (deny stranger)",
      ok: false,
      detail: "expected WithdrawRecipientNotAllowed but tx succeeded",
      signature: sig,
    });
  } catch (e) {
    const text = errText(e);
    const ok =
      text.includes("withdrawrecipientnotallowed") ||
      text.includes("withdraw recipient");
    const sig = txSig(e);
    smokeSignatures.treasuryWithdrawDenyStranger = sig;
    results.push({
      name: "treasury withdraw (deny stranger)",
      ok,
      detail: ok ? undefined : text.slice(0, 400),
      signature: sig,
    });
  }

  // --- Configure add / remove withdraw recipient ---
  try {
    const addSig = await program.methods
      .addWithdrawRecipient(stranger.publicKey)
      .accounts({
        pool,
        configureAuthority: configure.publicKey,
      } as any)
      .signers([configure])
      .rpc();
    smokeSignatures.addWithdrawRecipient = addSig;
    let acct: any = await (program.account as any).liquidityPool.fetch(pool);
    if (
      !(acct.withdrawRecipients as PublicKey[]).some((r) =>
        r.equals(stranger.publicKey)
      )
    ) {
      throw new Error("stranger not on allowlist after add");
    }
    const removeSig = await program.methods
      .removeWithdrawRecipient(stranger.publicKey)
      .accounts({
        pool,
        configureAuthority: configure.publicKey,
      } as any)
      .signers([configure])
      .rpc();
    smokeSignatures.removeWithdrawRecipient = removeSig;
    acct = await (program.account as any).liquidityPool.fetch(pool);
    if (
      (acct.withdrawRecipients as PublicKey[]).some((r) =>
        r.equals(stranger.publicKey)
      )
    ) {
      throw new Error("stranger still on allowlist after remove");
    }
    results.push({
      name: "configure add/remove withdraw recipient",
      ok: true,
      signature: `${addSig},${removeSig}`,
    });
  } catch (e) {
    results.push({
      name: "configure add/remove withdraw recipient",
      ok: false,
      detail: String(e),
      signature: txSig(e),
    });
  }

  // --- Post-migrate swap A -> B (unpaused) ---
  try {
    const before = await getAccount(connection, userTo);
    const sig = await doSwap();
    smokeSignatures.postMigrateSwap = sig;
    const after = await getAccount(connection, userTo);
    if (after.amount <= before.amount) {
      throw new Error("swap did not increase destination balance");
    }
    results.push({ name: "post-migrate swap", ok: true, signature: sig });
  } catch (e) {
    results.push({
      name: "post-migrate swap",
      ok: false,
      detail: errText(e),
      signature: txSig(e),
    });
  }

  console.log();
  console.log("Checklist:");
  let allOk = true;
  for (const r of results) {
    const mark = r.ok ? "PASS" : "FAIL";
    console.log(`  [${mark}] ${r.name}`);
    if (r.signature) {
      console.log(`         sig: ${r.signature}`);
    } else {
      console.log(`         sig: (none — simulation only)`);
    }
    if (!r.ok) {
      allOk = false;
      if (r.detail) console.log(`         ${r.detail.split("\n")[0]}`);
    }
  }

  updateState({
    phase: allOk ? "05-smoke-passed" : "05-smoke-failed",
    smokeSignatures,
  });

  console.log();
  if (!allOk) {
    console.error("❌ One or more smoke checks failed.");
    process.exit(1);
  }
  console.log("✓ All authority smoke checks passed.");
  console.log("✓ Signatures saved to state.smokeSignatures");
  console.log("Next: bash scripts/migration-verify/06-cleanup.sh");
}

async function ensureAta(
  provider: anchor.AnchorProvider,
  payer: Keypair,
  mint: PublicKey,
  owner: PublicKey
): Promise<PublicKey> {
  const ata = await getAssociatedTokenAddress(mint, owner);
  try {
    await getAccount(provider.connection, ata);
    return ata;
  } catch {
    const ix = createAssociatedTokenAccountInstruction(
      payer.publicKey,
      ata,
      owner,
      mint
    );
    const tx = new Transaction().add(ix);
    await provider.sendAndConfirm(tx, [payer]);
    return ata;
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
