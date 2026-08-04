/**
 * Phase 04: generate distinct role keypairs, run migrate_authorities, assert
 * new pool size and role fields.
 */
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import * as path from "path";
import {
  ARTIFACTS_CURRENT_DIR,
  KEYS_DIR,
  LEGACY_POOL_SIZE,
  NEW_POOL_SIZE,
  ensureVerifyDirs,
} from "./lib/paths";
import { loadState, updateState, RoleKeyPaths } from "./lib/state";
import {
  assertPoolSize,
  loadIdl,
  makeProgram,
  makeProvider,
  poolPda,
  writeKeypair,
} from "./lib/common";

async function main() {
  ensureVerifyDirs();
  const state = loadState();
  const { provider, connection, payer } = makeProvider(state);
  const programId = new PublicKey(state.programId);
  const pool = poolPda(programId);

  const idlPath = path.join(ARTIFACTS_CURRENT_DIR, "scaas_liquidity.json");
  const idl = loadIdl(idlPath);
  const program = makeProgram(idl, provider, programId);

  console.log("=".repeat(60));
  console.log("04 — MIGRATE AUTHORITIES");
  console.log("=".repeat(60));
  console.log("- Cluster:", state.cluster);
  console.log("- Program ID:", programId.toBase58());
  console.log("- Pool PDA:", pool.toBase58());
  console.log("- Legacy ops/pause (wallet):", payer.publicKey.toBase58());
  console.log();

  await assertPoolSize(connection, pool, LEGACY_POOL_SIZE, "pre-migrate");

  const rolePaths: RoleKeyPaths = {
    pause: path.join(KEYS_DIR, "role-pause.json"),
    unpause: path.join(KEYS_DIR, "role-unpause.json"),
    treasury: path.join(KEYS_DIR, "role-treasury.json"),
    configure: path.join(KEYS_DIR, "role-configure.json"),
    withdrawRecipient: path.join(KEYS_DIR, "role-withdraw-recipient.json"),
    stranger: path.join(KEYS_DIR, "role-stranger.json"),
  };

  const roles: Record<keyof RoleKeyPaths, Keypair> = {
    pause: Keypair.generate(),
    unpause: Keypair.generate(),
    treasury: Keypair.generate(),
    configure: Keypair.generate(),
    withdrawRecipient: Keypair.generate(),
    stranger: Keypair.generate(),
  };

  // Roles only sign; the wallet pays fees. No SOL top-up needed.
  for (const key of Object.keys(roles) as (keyof RoleKeyPaths)[]) {
    writeKeypair(rolePaths[key], roles[key]);
    console.log(`✓ ${key}: ${roles[key].publicKey.toBase58()}`);
  }
  console.log();
  console.log("Sending migrate_authorities...");
  const sig = await program.methods
    .migrateAuthorities(
      roles.pause.publicKey,
      roles.unpause.publicKey,
      roles.treasury.publicKey,
      roles.configure.publicKey,
      roles.withdrawRecipient.publicKey
    )
    .accounts({
      pool,
      legacyOperationsAuthority: payer.publicKey,
      legacyPauseAuthority: payer.publicKey,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
  console.log("✓ Migrated. Signature:", sig);

  await assertPoolSize(connection, pool, NEW_POOL_SIZE, "post-migrate");

  const poolAccount: any = await (program.account as any).liquidityPool.fetch(
    pool
  );
  const checks: [string, PublicKey, PublicKey][] = [
    ["pause_authority", poolAccount.pauseAuthority, roles.pause.publicKey],
    ["unpause_authority", poolAccount.unpauseAuthority, roles.unpause.publicKey],
    [
      "treasury_authority",
      poolAccount.treasuryAuthority,
      roles.treasury.publicKey,
    ],
    [
      "configure_authority",
      poolAccount.configureAuthority,
      roles.configure.publicKey,
    ],
  ];
  let failed = false;
  for (const [name, actual, want] of checks) {
    if (!actual.equals(want)) {
      console.error(
        `❌ ${name} = ${actual.toBase58()}, expected ${want.toBase58()}`
      );
      failed = true;
    } else {
      console.log(`✓ ${name} ok`);
    }
  }

  if (
    poolAccount.withdrawRecipients.length !== 1 ||
    !poolAccount.withdrawRecipients[0].equals(roles.withdrawRecipient.publicKey)
  ) {
    console.error(
      `❌ withdraw_recipients = [${poolAccount.withdrawRecipients
        .map((r: PublicKey) => r.toBase58())
        .join(", ")}], expected [${roles.withdrawRecipient.publicKey.toBase58()}]`
    );
    failed = true;
  } else {
    console.log("✓ withdraw_recipients seeded");
  }

  const feeRecipient = new PublicKey(
    state.feeRecipient ?? payer.publicKey.toBase58()
  );
  if (!poolAccount.feeRecipient.equals(feeRecipient)) {
    console.error(
      `❌ fee_recipient drifted: ${poolAccount.feeRecipient.toBase58()}`
    );
    failed = true;
  } else {
    console.log("✓ fee_recipient preserved");
  }

  if (state.mintA && state.mintB) {
    const tokens = (poolAccount.supportedTokens as PublicKey[]).map((t) =>
      t.toBase58()
    );
    for (const mint of [state.mintA, state.mintB]) {
      if (!tokens.includes(mint)) {
        console.error(`❌ supported_tokens missing ${mint}`);
        failed = true;
      }
    }
    if (!failed) console.log("✓ supported_tokens preserved");
  }

  if (poolAccount.feeRate.toNumber() !== (state.feeRateBps ?? 0)) {
    console.error(
      `❌ fee_rate = ${poolAccount.feeRate.toNumber()}, expected ${
        state.feeRateBps ?? 0
      }`
    );
    failed = true;
  } else {
    console.log("✓ fee_rate preserved");
  }

  if (failed) {
    process.exit(1);
  }

  updateState({
    roleKeyPaths: rolePaths,
    migrateSignature: sig,
    phase: "04-migrated",
  });

  console.log();
  console.log("✓ Migration verified.");
  console.log("Next: yarn ts-node scripts/migration-verify/05-smoke-authorities.ts");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
