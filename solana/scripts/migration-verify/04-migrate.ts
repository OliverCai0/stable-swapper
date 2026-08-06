/**
 * Phase 04: generate distinct role keypairs, run migrate_authorities, assert
 * new pool size and role fields.
 *
 * `migrate_authorities` is gated on the program upgrade authority, not on the
 * legacy pool authorities, so the wallet that deployed in phase 01/03 is the
 * only key that can sign this.
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
  errText,
  loadIdl,
  makeProgram,
  makeProvider,
  poolPda,
  programDataAddress,
  readUpgradeAuthority,
  writeKeypair,
} from "./lib/common";
import * as ui from "./lib/ui";

async function main() {
  ensureVerifyDirs();
  const state = loadState();
  const { provider, connection, payer } = makeProvider(state);
  const programId = new PublicKey(state.programId);
  const pool = poolPda(programId);
  const programData = programDataAddress(programId);

  const idlPath = path.join(ARTIFACTS_CURRENT_DIR, "stable_swapper.json");
  const idl = loadIdl(idlPath);
  const program = makeProgram(idl, provider, programId);

  ui.banner(
    "04 — MIGRATE AUTHORITIES",
    "in-place realloc, gated on the program upgrade authority"
  );
  ui.kv("Cluster", state.cluster);
  ui.kv("Program ID", programId.toBase58());
  ui.kv("Pool PDA", pool.toBase58());
  ui.kv("ProgramData", programData.toBase58());
  ui.kv("Signer", payer.publicKey.toBase58());
  await ui.pace();

  ui.section("Authorisation");
  const upgradeAuthority = await readUpgradeAuthority(connection, programId);
  if (!upgradeAuthority) {
    throw new Error(
      `Program ${programId.toBase58()} is immutable or has no ProgramData; ` +
        "migrate_authorities requires an upgrade authority to sign."
    );
  }
  if (!upgradeAuthority.equals(payer.publicKey)) {
    throw new Error(
      `Wallet ${payer.publicKey.toBase58()} is not the upgrade authority ` +
        `(${upgradeAuthority.toBase58()}). migrate_authorities would fail with NotUpgradeAuthority.`
    );
  }
  ui.ok("Wallet is the program upgrade authority");
  ui.note(
    "Legacy pool authorities are not consulted — hot keys cannot trigger a migration."
  );
  await ui.pace();

  ui.section("Pre-migration state");
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

  ui.section("New role keys");
  // Roles only sign; the wallet pays fees. No SOL top-up needed.
  const roleClass: Record<keyof RoleKeyPaths, string> = {
    pause: ui.color.yellow("hot "),
    unpause: ui.color.cyan("cold"),
    treasury: ui.color.yellow("hot "),
    configure: ui.color.cyan("cold"),
    withdrawRecipient: ui.color.gray("addr"),
    stranger: ui.color.gray("addr"),
  };
  for (const key of Object.keys(roles) as (keyof RoleKeyPaths)[]) {
    writeKeypair(rolePaths[key], roles[key]);
    ui.ok(
      `${roleClass[key]} ${key.padEnd(18)} ${ui.color.dim(
        roles[key].publicKey.toBase58()
      )}`
    );
    await ui.pace(120);
  }

  // Negative case first: the pool is still legacy-sized, so a rejection here can only
  // come from the upgrade-authority gate rather than from an already-migrated account.
  ui.section("Guard check");
  const guard = ui.spinner(
    "Sending migrate_authorities from an unauthorised signer…"
  );
  const impostor = Keypair.generate();
  try {
    await program.methods
      .migrateAuthorities(
        roles.pause.publicKey,
        roles.unpause.publicKey,
        roles.treasury.publicKey,
        roles.configure.publicKey,
        roles.withdrawRecipient.publicKey
      )
      .accounts({
        pool,
        payer: impostor.publicKey,
        programData,
        systemProgram: SystemProgram.programId,
      } as any)
      .signers([impostor])
      .rpc();
    guard.fail("migrate_authorities accepted an unauthorised signer");
    process.exit(1);
  } catch (e) {
    const text = errText(e);
    if (!text.includes("notupgradeauthority")) {
      guard.fail(`Expected NotUpgradeAuthority, got: ${text.slice(0, 300)}`);
      process.exit(1);
    }
    guard.succeed(
      `Unauthorised signer rejected — ${ui.color.magenta(
        "NotUpgradeAuthority"
      )}`
    );
  }
  await ui.pace();

  ui.section("Migration");
  const migrating = ui.spinner(
    "Sending migrate_authorities as the upgrade authority…"
  );
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
      payer: payer.publicKey,
      programData,
      systemProgram: SystemProgram.programId,
    } as any)
    .rpc();
  migrating.succeed("Migrated");
  ui.signatureLine(sig);

  await assertPoolSize(connection, pool, NEW_POOL_SIZE, "post-migrate");
  ui.blank();
  console.log(
    `    ${ui.color.gray(String(LEGACY_POOL_SIZE))} ${ui.growthBar(
      LEGACY_POOL_SIZE,
      NEW_POOL_SIZE
    )} ${ui.color.bold(String(NEW_POOL_SIZE))} bytes  ${ui.color.yellow(
      `+${NEW_POOL_SIZE - LEGACY_POOL_SIZE}`
    )}`
  );
  ui.note(
    `grown in place at the same PDA ${pool.toBase58()} — no new account, no pool redeploy`
  );
  ui.blank();
  await ui.pace();

  ui.section("Post-migration verification");

  const poolAccount: any = await (program.account as any).liquidityPool.fetch(
    pool
  );
  const checks: [string, PublicKey, PublicKey][] = [
    ["pause_authority", poolAccount.pauseAuthority, roles.pause.publicKey],
    [
      "unpause_authority",
      poolAccount.unpauseAuthority,
      roles.unpause.publicKey,
    ],
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
      ui.fail(`${name} = ${actual.toBase58()}, expected ${want.toBase58()}`);
      failed = true;
    } else {
      ui.ok(`${name.padEnd(20)} ${ui.color.dim(actual.toBase58())}`);
    }
    await ui.pace(120);
  }

  if (
    poolAccount.withdrawRecipients.length !== 1 ||
    !poolAccount.withdrawRecipients[0].equals(roles.withdrawRecipient.publicKey)
  ) {
    console.error(
      `❌ withdraw_recipients = [${poolAccount.withdrawRecipients
        .map((r: PublicKey) => r.toBase58())
        .join(
          ", "
        )}], expected [${roles.withdrawRecipient.publicKey.toBase58()}]`
    );
    failed = true;
  } else {
    ui.ok("withdraw_recipients seeded");
  }

  const feeRecipient = new PublicKey(
    state.feeRecipient ?? payer.publicKey.toBase58()
  );
  if (!poolAccount.feeRecipient.equals(feeRecipient)) {
    ui.fail(`fee_recipient drifted: ${poolAccount.feeRecipient.toBase58()}`);
    failed = true;
  } else {
    ui.ok("fee_recipient preserved");
  }

  if (state.mintA && state.mintB) {
    const tokens = (poolAccount.supportedTokens as PublicKey[]).map((t) =>
      t.toBase58()
    );
    for (const mint of [state.mintA, state.mintB]) {
      if (!tokens.includes(mint)) {
        ui.fail(`supported_tokens missing ${mint}`);
        failed = true;
      }
    }
    if (!failed) {
      ui.ok(`supported_tokens preserved (${tokens.length} listed)`);
    }
  }

  if (poolAccount.feeRate.toNumber() !== (state.feeRateBps ?? 0)) {
    ui.fail(
      `fee_rate = ${poolAccount.feeRate.toNumber()}, expected ${
        state.feeRateBps ?? 0
      }`
    );
    failed = true;
  } else {
    ui.ok("fee_rate preserved");
  }

  if (failed) {
    process.exit(1);
  }

  updateState({
    roleKeyPaths: rolePaths,
    migrateSignature: sig,
    phase: "04-migrated",
  });

  ui.blank();
  console.log(`  ${ui.color.green(ui.color.bold("Migration verified."))}`);
  ui.note(
    "Next: yarn ts-node scripts/migration-verify/05-smoke-authorities.ts"
  );
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
