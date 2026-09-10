/*
 * mainnet-swap-verify.js — post-migration smoke test for the stable-swapper pool.
 *
 * Executes a REAL, small USDC -> USDF swap on solana-mainnet to prove swaps are
 * operational after the PR #9 upgrade + migrate. Moves real funds (a few cents).
 *
 * RUN ONLY AFTER the migration apply completes.
 *
 * Prereqs on the wallet (WALLET keypair):
 *   - a little SOL (~0.01) for fees + ATA rents
 *   - a small USDC balance (>= AMOUNT_USDC; e.g. 0.05 USDC)
 *   - USDC ATA exists automatically once funded; the script creates the USDF ATA
 *     if missing, and the program init_if_needed-creates the fee recipient's USDC ATA.
 *
 * Usage (from coinbase/stable-swapper/solana):
 *   WALLET=~/.config/solana/swap-verify.json \
 *   IDL_PATH=/Users/olivercai/Desktop/smart-contracts/stable-swapper-svm/terraform/solana-prod/build/1.0.0/idl.json \
 *   AMOUNT_USDC=0.05 \
 *   node mainnet-swap-verify.js
 */
const fs = require("fs");
const os = require("os");
const anchor = require("@coral-xyz/anchor");
const { PublicKey, Keypair, Connection } = require("@solana/web3.js");
const {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} = require("@solana/spl-token");

const RPC = process.env.RPC || "https://api.mainnet-beta.solana.com";
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDF = new PublicKey("5AMAA9JV9H97YYVxx8F6FsCMmTwXSuTTQneiup4RYAUQ");
const AMOUNT = Math.round(parseFloat(process.env.AMOUNT_USDC || "0.05") * 1e6); // USDC has 6 decimals

function loadKeypair(p) {
  const path = p.replace(/^~/, os.homedir());
  return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path))));
}

(async () => {
  if (!process.env.WALLET) throw new Error("set WALLET=<keypair path>");
  const idlPath =
    process.env.IDL_PATH ||
    "/Users/olivercai/Desktop/smart-contracts/stable-swapper-svm/terraform/solana-prod/build/1.0.0/idl.json";
  const idl = JSON.parse(fs.readFileSync(idlPath));

  const payer = loadKeypair(process.env.WALLET);
  const connection = new Connection(RPC, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(payer), {
    commitment: "confirmed",
  });
  const program = new anchor.Program(idl, provider);
  const PROG = program.programId;
  console.log("program:", PROG.toBase58(), "| payer:", payer.publicKey.toBase58());

  const s = (x) => Buffer.from(x);
  const [pool] = PublicKey.findProgramAddressSync([s("liquidity_pool")], PROG);
  const [inVault] = PublicKey.findProgramAddressSync([s("token_vault"), pool.toBuffer(), USDC.toBuffer()], PROG);
  const [outVault] = PublicKey.findProgramAddressSync([s("token_vault"), pool.toBuffer(), USDF.toBuffer()], PROG);
  const [inVaultTA] = PublicKey.findProgramAddressSync([s("vault_token_account"), inVault.toBuffer()], PROG);
  const [outVaultTA] = PublicKey.findProgramAddressSync([s("vault_token_account"), outVault.toBuffer()], PROG);

  // Confirm the pool is migrated + swaps enabled before spending anything.
  const poolAcct = await program.account.liquidityPool.fetch(pool);
  console.log("swaps_paused:", poolAcct.swapsPaused, "| fee_rate(bps):", poolAcct.feeRate.toString());
  if (poolAcct.swapsPaused) throw new Error("swaps are paused — unpause before verifying");
  const feeRecipient = poolAcct.feeRecipient;

  const userUsdc = getAssociatedTokenAddressSync(USDC, payer.publicKey);
  const usdcBal = (await getAccount(connection, userUsdc)).amount;
  if (usdcBal < BigInt(AMOUNT)) throw new Error(`USDC balance ${usdcBal} < amount ${AMOUNT}; fund the wallet with USDC`);

  // Ensure the USDF output ATA exists (program does NOT create it).
  const userUsdf = (
    await getOrCreateAssociatedTokenAccount(connection, payer, USDF, payer.publicKey)
  ).address;
  const feeRecipientTA = getAssociatedTokenAddressSync(USDC, feeRecipient, true);

  const before = {
    usdc: (await getAccount(connection, userUsdc)).amount,
    usdf: (await getAccount(connection, userUsdf)).amount,
  };
  console.log("before  USDC:", before.usdc.toString(), "USDF:", before.usdf.toString());

  const builder = program.methods
    .swap(new anchor.BN(AMOUNT), new anchor.BN(1)) // min_out=1 base unit (verification, not slippage-sensitive)
    .accounts({
      pool,
      inVault,
      outVault,
      inVaultTokenAccount: inVaultTA,
      outVaultTokenAccount: outVaultTA,
      userFromTokenAccount: userUsdc,
      toTokenAccount: userUsdf,
      feeRecipientTokenAccount: feeRecipientTA,
      feeRecipient,
      fromMint: USDC,
      toMint: USDF,
      user: payer.publicKey,
      tokenProgram: TOKEN_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: anchor.web3.SystemProgram.programId,
    });

  // DRY_RUN=1 simulates the swap (no funds moved, nothing committed) and prints logs.
  if (process.env.DRY_RUN) {
    const sim = await builder.simulate();
    console.log("DRY RUN — simulation logs:");
    (sim.raw || sim.logs || []).forEach((l) => console.log("  " + l));
    console.log("✅ simulation succeeded (no funds moved). Unset DRY_RUN to execute for real.");
    return;
  }

  const sig = await builder.rpc();

  const after = {
    usdc: (await getAccount(connection, userUsdc)).amount,
    usdf: (await getAccount(connection, userUsdf)).amount,
  };
  console.log("after   USDC:", after.usdc.toString(), "USDF:", after.usdf.toString());
  console.log("USDC spent:", (before.usdc - after.usdc).toString(), "| USDF received:", (after.usdf - before.usdf).toString());
  console.log("✅ swap tx:", sig);
  console.log("   https://explorer.solana.com/tx/" + sig);
})().catch((e) => {
  console.error("❌ swap verify failed:", e.message || e);
  process.exit(1);
});
