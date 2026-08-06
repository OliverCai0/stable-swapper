/**
 * Phase 05: authority smoke on the migrated pool, plus a post-migrate swap.
 *
 * Checks are grouped to show what the role split actually buys. Hot keys keep the
 * incident-response levers (pause, and withdrawing to an already-approved
 * destination). Everything that changes where money can go — listing tokens, fee
 * config, the payout allowlist, unpausing — is reachable only by the cold keys.
 */
import * as anchor from "@coral-xyz/anchor";
import {
  createAssociatedTokenAccountInstruction,
  createMint,
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
  KEYS_DIR,
  NEW_POOL_SIZE,
  ensureVerifyDirs,
} from "./lib/paths";
import { loadState, updateState, SmokeSignatures } from "./lib/state";
import {
  assertPoolSize,
  errText,
  fundKeypair,
  loadIdl,
  makeProgram,
  makeProvider,
  poolPda,
  readKeypair,
  vaultPdas,
  writeKeypair,
} from "./lib/common";

const DEMO_MINT_DECIMALS = 6;
/**
 * Enough for the vault, vault token account, and fee-recipient ATA that listing creates.
 * The hot keys get the same balance so that when they are refused, it is unambiguously
 * the role check refusing them and not a missing rent payment. Anchor defers a `has_one`
 * that references a later-declared account, so an unfunded impostor would trip the
 * `init` rent transfer first and report the wrong reason.
 */
const ROLE_FUNDING_SOL = 0.1;

/** Anchor's `has_one` rejection, i.e. "signed by the wrong role". */
const WRONG_ROLE = ["constrainthasone", "has one constraint"];

type Group = "hot-allowed" | "hot-blocked" | "cold" | "pool";

const GROUPS: [Group, string][] = [
  ["hot-allowed", "Hot keys — allowed to act alone"],
  ["hot-blocked", "Hot keys — blocked, cold-key quorum required"],
  ["cold", "Cold keys — quorum-gated actions"],
  ["pool", "Pool behaviour"],
];

interface CheckResult {
  group: Group;
  name: string;
  ok: boolean;
  /** Error the program was expected to raise, shown for denial checks. */
  expected?: string;
  detail?: string;
  signature?: string | null;
}

/** Prefer landed signature; Anchor sim failures usually have an empty signature. */
function txSig(error: unknown): string | null {
  const e = error as { signature?: string };
  return e?.signature ? e.signature : null;
}

/** Pull the line that says why out of a program log dump, skipping `invoke`/`consumed` noise. */
function summarize(detail: string): string {
  const lines = detail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const reason = lines.find(
    (line) => line.includes("error") || line.includes("failed")
  );
  return (reason ?? lines[0] ?? "").slice(0, 300);
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
  const idl = loadIdl(path.join(ARTIFACTS_CURRENT_DIR, "stable_swapper.json"));
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
  console.log("Roles on the migrated pool:");
  console.log(`  pause     (hot)  ${pause.publicKey.toBase58()}`);
  console.log(`  treasury  (hot)  ${treasury.publicKey.toBase58()}`);
  console.log(`  unpause   (cold) ${unpause.publicKey.toBase58()}`);
  console.log(`  configure (cold) ${configure.publicKey.toBase58()}`);
  console.log();

  await assertPoolSize(connection, pool, NEW_POOL_SIZE, "smoke start");

  const results: CheckResult[] = [];
  const smokeSignatures: SmokeSignatures = {};

  async function allow(
    group: Group,
    name: string,
    run: () => Promise<string>,
    key?: keyof SmokeSignatures,
    verify?: () => Promise<void>
  ): Promise<void> {
    try {
      const sig = await run();
      if (key) smokeSignatures[key] = sig;
      if (verify) await verify();
      results.push({ group, name, ok: true, signature: sig });
    } catch (e) {
      results.push({
        group,
        name,
        ok: false,
        detail: errText(e),
        signature: txSig(e),
      });
    }
  }

  async function deny(
    group: Group,
    name: string,
    run: () => Promise<string>,
    expected: string,
    needles: string[],
    key?: keyof SmokeSignatures
  ): Promise<void> {
    try {
      const sig = await run();
      if (key) smokeSignatures[key] = sig;
      results.push({
        group,
        name,
        ok: false,
        expected,
        detail: `expected ${expected} but the transaction succeeded`,
        signature: sig,
      });
    } catch (e) {
      const text = errText(e);
      const ok = needles.some((needle) => text.includes(needle));
      const sig = txSig(e);
      if (key) smokeSignatures[key] = sig;
      results.push({
        group,
        name,
        ok,
        expected,
        detail: ok ? undefined : text.slice(0, 400),
        signature: sig,
      });
    }
  }

  const poolState = async (): Promise<any> =>
    (program.account as any).liquidityPool.fetch(pool);

  const originalPool = await poolState();
  const originalFeeRecipient: PublicKey = originalPool.feeRecipient;
  const originalFeeRate: number = originalPool.feeRate.toNumber();

  // Listing a token makes the signing authority the rent payer for three new accounts.
  for (const role of [configure, pause, treasury]) {
    await fundKeypair(connection, payer, role.publicKey, ROLE_FUNDING_SOL);
  }

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
    const acct = await poolState();
    const feeRecipientAta = await getAssociatedTokenAddress(
      mintA,
      acct.feeRecipient
    );
    return program.methods
      .swap(swapAmountIn, swapMinOut)
      .accounts({
        pool,
        inVault: vault,
        outVault,
        inVaultTokenAccount: vaultTokenAccount,
        outVaultTokenAccount: outVaultAta,
        userFromTokenAccount: userFrom,
        toTokenAccount: userTo,
        feeRecipientTokenAccount: feeRecipientAta,
        feeRecipient: acct.feeRecipient,
        fromMint: mintA,
        toMint: mintB,
        user: payer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      } as any)
      .rpc();
  }

  /** `signer` stands in for the treasury role; only the real one is accepted. */
  async function doWithdraw(
    recipientTokenAccount: PublicKey,
    signer: Keypair = treasury
  ): Promise<string> {
    return program.methods
      .withdrawLiquidity(withdrawOne)
      .accounts({
        pool,
        vault,
        vaultTokenAccount,
        recipientTokenAccount,
        mint: mintA,
        treasuryAuthority: signer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      } as any)
      .signers([signer])
      .rpc();
  }

  // A throwaway mint so "listing a token" is a real listing every run. Delisted below.
  const demoMintKp = Keypair.generate();
  const demoMintPath = path.join(KEYS_DIR, "demo-mint.json");
  writeKeypair(demoMintPath, demoMintKp);
  const demoMint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    DEMO_MINT_DECIMALS,
    demoMintKp
  );
  const { vault: demoVault, vaultTokenAccount: demoVaultAta } = vaultPdas(
    programId,
    pool,
    demoMint
  );
  console.log("- Demo mint to list:", demoMint.toBase58());
  console.log();

  /** `signer` stands in for the configure role; only the real one is accepted. */
  async function doListToken(signer: Keypair = configure): Promise<string> {
    const acct = await poolState();
    const feeRecipientAta = await getAssociatedTokenAddress(
      demoMint,
      acct.feeRecipient
    );
    return program.methods
      .addSupportedToken()
      .accounts({
        pool,
        vault: demoVault,
        vaultTokenAccount: demoVaultAta,
        feeRecipientTokenAccount: feeRecipientAta,
        feeRecipient: acct.feeRecipient,
        mint: demoMint,
        configureAuthority: signer.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      } as any)
      .signers([signer])
      .rpc();
  }

  // --- Hot pause key takes swaps offline; swap is rejected ---
  await allow(
    "hot-allowed",
    "pause swaps",
    () =>
      program.methods
        .pauseSwaps()
        .accounts({ pool, pauseAuthority: pause.publicKey } as any)
        .signers([pause])
        .rpc(),
    "pauseSwaps",
    async () => {
      if (!(await poolState()).swapsPaused) {
        throw new Error("swaps_paused still false");
      }
    }
  );

  await deny(
    "pool",
    "swap rejected while swaps are paused",
    doSwap,
    "SwapsPaused",
    ["swapspaused", "swaps paused"],
    "swapWhilePaused"
  );

  // --- The key that paused cannot bring the pool back up ---
  await deny(
    "hot-blocked",
    "pause key cannot unpause swaps",
    () =>
      program.methods
        .unpauseSwaps()
        .accounts({ pool, unpauseAuthority: pause.publicKey } as any)
        .signers([pause])
        .rpc(),
    "ConstraintHasOne",
    WRONG_ROLE,
    "hotUnpauseDenied"
  );

  await allow(
    "cold",
    "unpause swaps",
    () =>
      program.methods
        .unpauseSwaps()
        .accounts({ pool, unpauseAuthority: unpause.publicKey } as any)
        .signers([unpause])
        .rpc(),
    "unpauseSwaps",
    async () => {
      if ((await poolState()).swapsPaused) {
        throw new Error("swaps_paused still true");
      }
    }
  );

  // --- Same shape for withdraws ---
  await allow(
    "hot-allowed",
    "pause withdraws",
    () =>
      program.methods
        .pauseWithdraws()
        .accounts({ pool, pauseAuthority: pause.publicKey } as any)
        .signers([pause])
        .rpc(),
    "pauseWithdraws",
    async () => {
      if (!(await poolState()).liquidityPaused) {
        throw new Error("liquidity_paused still false");
      }
    }
  );

  await deny(
    "pool",
    "withdraw rejected while withdraws are paused",
    () => doWithdraw(recipientAta),
    "LiquidityPaused",
    ["liquiditypaused", "liquidity paused"],
    "withdrawWhilePaused"
  );

  await allow(
    "cold",
    "unpause withdraws",
    () =>
      program.methods
        .unpauseWithdraws()
        .accounts({ pool, unpauseAuthority: unpause.publicKey } as any)
        .signers([unpause])
        .rpc(),
    "unpauseWithdraws",
    async () => {
      if ((await poolState()).liquidityPaused) {
        throw new Error("liquidity_paused still true");
      }
    }
  );

  // --- Treasury may move funds, but only to an address the cold key approved ---
  await allow(
    "hot-allowed",
    "treasury withdraw to allowlisted recipient",
    () => doWithdraw(recipientAta),
    "treasuryWithdrawAllowlisted"
  );

  await deny(
    "hot-blocked",
    "treasury cannot withdraw to an un-allowlisted owner",
    () => doWithdraw(strangerAta),
    "WithdrawRecipientNotAllowed",
    ["withdrawrecipientnotallowed", "withdraw recipient"],
    "treasuryWithdrawDenyStranger"
  );

  await deny(
    "hot-blocked",
    "treasury cannot add its own payout address",
    () =>
      program.methods
        .addWithdrawRecipient(stranger.publicKey)
        .accounts({ pool, configureAuthority: treasury.publicKey } as any)
        .signers([treasury])
        .rpc(),
    "ConstraintHasOne",
    WRONG_ROLE,
    "hotAddPayoutDenied"
  );

  await deny(
    "hot-blocked",
    "pause key cannot withdraw liquidity",
    () => doWithdraw(recipientAta, pause),
    "ConstraintHasOne",
    WRONG_ROLE,
    "hotWithdrawDenied"
  );

  // --- Only the configure (cold) key edits the payout allowlist ---
  await allow("cold", "configure add/remove withdraw recipient", async () => {
    const addSig = await program.methods
      .addWithdrawRecipient(stranger.publicKey)
      .accounts({ pool, configureAuthority: configure.publicKey } as any)
      .signers([configure])
      .rpc();
    smokeSignatures.addWithdrawRecipient = addSig;
    let acct = await poolState();
    if (
      !(acct.withdrawRecipients as PublicKey[]).some((r) =>
        r.equals(stranger.publicKey)
      )
    ) {
      throw new Error("stranger not on allowlist after add");
    }
    const removeSig = await program.methods
      .removeWithdrawRecipient(stranger.publicKey)
      .accounts({ pool, configureAuthority: configure.publicKey } as any)
      .signers([configure])
      .rpc();
    smokeSignatures.removeWithdrawRecipient = removeSig;
    acct = await poolState();
    if (
      (acct.withdrawRecipients as PublicKey[]).some((r) =>
        r.equals(stranger.publicKey)
      )
    ) {
      throw new Error("stranger still on allowlist after remove");
    }
    return `${addSig},${removeSig}`;
  });

  // --- Listing a token is a cold-key action ---
  await deny(
    "hot-blocked",
    "pause key cannot list a token",
    () => doListToken(pause),
    "ConstraintHasOne",
    WRONG_ROLE,
    "hotListTokenDenied"
  );

  await allow(
    "cold",
    "configure lists a new token",
    () => doListToken(),
    "configureListToken",
    async () => {
      const acct = await poolState();
      if (
        !(acct.supportedTokens as PublicKey[]).some((t) => t.equals(demoMint))
      ) {
        throw new Error(
          "demo mint missing from supported_tokens after listing"
        );
      }
    }
  );

  // --- Fee configuration is a cold-key action ---
  await deny(
    "hot-blocked",
    "treasury cannot update the fee rate",
    () =>
      program.methods
        .updateFeeRate(new anchor.BN(originalFeeRate + 25))
        .accounts({ pool, configureAuthority: treasury.publicKey } as any)
        .signers([treasury])
        .rpc(),
    "ConstraintHasOne",
    WRONG_ROLE,
    "hotUpdateFeeRateDenied"
  );

  await deny(
    "hot-blocked",
    "treasury cannot redirect the fee recipient",
    () =>
      program.methods
        .updateFeeRecipient(treasury.publicKey)
        .accounts({ pool, configureAuthority: treasury.publicKey } as any)
        .signers([treasury])
        .rpc(),
    "ConstraintHasOne",
    WRONG_ROLE,
    "hotUpdateFeeRecipientDenied"
  );

  await allow(
    "cold",
    "configure updates the fee rate (and restores it)",
    async () => {
      const sig = await program.methods
        .updateFeeRate(new anchor.BN(originalFeeRate + 25))
        .accounts({ pool, configureAuthority: configure.publicKey } as any)
        .signers([configure])
        .rpc();
      if ((await poolState()).feeRate.toNumber() !== originalFeeRate + 25) {
        throw new Error("fee_rate did not change");
      }
      await program.methods
        .updateFeeRate(new anchor.BN(originalFeeRate))
        .accounts({ pool, configureAuthority: configure.publicKey } as any)
        .signers([configure])
        .rpc();
      return sig;
    },
    "configureUpdateFeeRate"
  );

  await allow(
    "cold",
    "configure updates the fee recipient (and restores it)",
    async () => {
      const sig = await program.methods
        .updateFeeRecipient(stranger.publicKey)
        .accounts({ pool, configureAuthority: configure.publicKey } as any)
        .signers([configure])
        .rpc();
      if (!(await poolState()).feeRecipient.equals(stranger.publicKey)) {
        throw new Error("fee_recipient did not change");
      }
      await program.methods
        .updateFeeRecipient(originalFeeRecipient)
        .accounts({ pool, configureAuthority: configure.publicKey } as any)
        .signers([configure])
        .rpc();
      return sig;
    },
    "configureUpdateFeeRecipient"
  );

  // --- Delist the demo token: hot key can disable it, cold key removes it ---
  await allow(
    "hot-allowed",
    "pause key disables the demo token",
    () =>
      program.methods
        .pauseToken()
        .accounts({
          pool,
          vault: demoVault,
          mint: demoMint,
          pauseAuthority: pause.publicKey,
        } as any)
        .signers([pause])
        .rpc(),
    "pauseToken"
  );

  await allow(
    "cold",
    "configure delists the demo token",
    () =>
      program.methods
        .removeSupportedToken()
        .accounts({
          pool,
          vault: demoVault,
          vaultTokenAccount: demoVaultAta,
          mint: demoMint,
          configureAuthority: configure.publicKey,
          tokenProgram: TOKEN_PROGRAM_ID,
        } as any)
        .signers([configure])
        .rpc(),
    "configureDelistToken",
    async () => {
      const acct = await poolState();
      if (
        (acct.supportedTokens as PublicKey[]).some((t) => t.equals(demoMint))
      ) {
        throw new Error("demo mint still listed after delist");
      }
    }
  );

  // --- Post-migrate swap A -> B (unpaused) ---
  await allow(
    "pool",
    "post-migrate swap",
    async () => {
      const before = await getAccount(connection, userTo);
      const sig = await doSwap();
      const after = await getAccount(connection, userTo);
      if (after.amount <= before.amount) {
        throw new Error("swap did not increase destination balance");
      }
      return sig;
    },
    "postMigrateSwap"
  );

  console.log();
  console.log("Checklist:");
  let allOk = true;
  for (const [group, title] of GROUPS) {
    const inGroup = results.filter((r) => r.group === group);
    if (inGroup.length === 0) continue;
    console.log();
    console.log(`  ${title}`);
    for (const r of inGroup) {
      const mark = r.ok ? "PASS" : "FAIL";
      const suffix = r.expected ? ` — rejected with ${r.expected}` : "";
      console.log(`    [${mark}] ${r.name}${suffix}`);
      console.log(
        r.signature
          ? `           sig: ${r.signature}`
          : `           sig: (none — rejected in simulation)`
      );
      if (!r.ok) {
        allOk = false;
        if (r.detail) console.log(`           ${summarize(r.detail)}`);
      }
    }
  }

  updateState({
    phase: allOk ? "05-smoke-passed" : "05-smoke-failed",
    smokeSignatures,
    demoMint: demoMint.toBase58(),
    demoMintKeypairPath: demoMintPath,
  });

  console.log();
  if (!allOk) {
    console.error("❌ One or more smoke checks failed.");
    process.exit(1);
  }
  console.log("✓ All authority smoke checks passed.");
  console.log(
    "✓ Every hot-key attempt at a value-moving config change was rejected on-chain."
  );
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
