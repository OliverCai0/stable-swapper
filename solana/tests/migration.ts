/**
 * End-to-end test for the one-shot `migrate_authorities` instruction.
 *
 * The pool is a PDA, so a legacy-layout pool can't be produced by the new program's
 * `initialize` (which only writes the new layout) and can't be created by an external
 * keypair. We use `solana-bankrun` to deploy the program in an in-process SVM and
 * `context.setAccount` to fabricate a legacy-layout pool at the canonical PDA, then run the
 * real instruction (legacy parse + realloc + rent top-up + reserialize) and assert the
 * migrated state. This is what catches the borsh packed-vs-padded parsing bug: the legacy
 * `supported_tokens` vec is packed, so the trailing fixed fields (fee_rate, pause flags,
 * bump) live at `108 + len * 32`, not `108 + MAX_SUPPORTED_TOKENS * 32`.
 */
import * as path from "path";
import { Program, BN } from "@coral-xyz/anchor";
import { PublicKey, Keypair, SystemProgram } from "@solana/web3.js";
import { start, ProgramTestContext } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { assert } from "chai";
import { StableSwapper } from "../target/types/stable_swapper";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const IDL = require("../target/idl/stable_swapper.json");

const MAX_SUPPORTED_TOKENS = 50;
// Pre-migration on-chain size: disc + ops + pause + fee_recipient + supported_tokens cap
// + fee_rate + 2 bools + bump. Matches `LiquidityPool::LEGACY_INIT_SPACE` (+ 8 disc).
const LEGACY_TOTAL =
  8 + (32 * 3 + (4 + 32 * MAX_SUPPORTED_TOKENS) + 8 + 1 + 1 + 1);

const LIQUIDITY_POOL_SEED = Buffer.from("liquidity_pool");
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

// `migrate_authorities` is gated on the program upgrade authority, which it reads from the
// ProgramData account. Bankrun registers programs under the non-upgradeable loader, so no such
// account exists and the test installs one: bincode-encoded `UpgradeableLoaderState::ProgramData`
// is a u32 variant tag (3), a u64 slot, then `Option<Pubkey>` as a one-byte tag plus the key.
function programDataBytes(upgradeAuthority: PublicKey | null): Buffer {
  const buf = Buffer.alloc(45);
  buf.writeUInt32LE(3, 0);
  buf.writeBigUInt64LE(BigInt(0), 4);
  if (upgradeAuthority) {
    buf.writeUInt8(1, 12);
    upgradeAuthority.toBuffer().copy(buf, 13);
  }
  return buf;
}

interface LegacyFields {
  ops: PublicKey;
  pause: PublicKey;
  feeRecipient: PublicKey;
  tokens: PublicKey[];
  feeRate: number;
  swapsPaused: boolean;
  liquidityPaused: boolean;
  bump: number;
}

// Serialize a legacy pool exactly as borsh/Anchor would have written it: the `supported_tokens`
// vec is packed (len + len*32), with the trailing fixed fields immediately after, and the
// remainder of the allocated account left as zero padding.
function buildLegacyPoolData(disc: Buffer, f: LegacyFields): Buffer {
  const buf = Buffer.alloc(LEGACY_TOTAL);
  disc.copy(buf, 0);
  f.ops.toBuffer().copy(buf, 8);
  f.pause.toBuffer().copy(buf, 40);
  f.feeRecipient.toBuffer().copy(buf, 72);
  buf.writeUInt32LE(f.tokens.length, 104);
  f.tokens.forEach((t, i) => t.toBuffer().copy(buf, 108 + i * 32));
  const trailing = 108 + f.tokens.length * 32;
  buf.writeBigUInt64LE(BigInt(f.feeRate), trailing);
  buf.writeUInt8(f.swapsPaused ? 1 : 0, trailing + 8);
  buf.writeUInt8(f.liquidityPaused ? 1 : 0, trailing + 9);
  buf.writeUInt8(f.bump, trailing + 10);
  return buf;
}

/// Per-test substitutions for the accounts and role arguments the migration takes, so a test
/// can vary one input while leaving the rest at their happy-path values.
interface MigrateOverrides {
  payer?: PublicKey;
  programData?: PublicKey;
  signers?: Keypair[];
  newPause?: PublicKey;
  newUnpause?: PublicKey;
  newTreasury?: PublicKey;
  newConfigure?: PublicKey;
  newWithdrawRecipient?: PublicKey;
}

function errText(error: any): string {
  const logs = Array.isArray(error?.logs) ? error.logs.join("\n") : "";
  return `${logs}\n${error?.transactionMessage ?? ""}\n${error}`.toLowerCase();
}

describe("migrate_authorities (bankrun)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<StableSwapper>;
  let programId: PublicKey;
  let pool: PublicKey;
  let poolBump: number;
  let programData: PublicKey;
  let payer: PublicKey;
  let accountDiscriminator: Buffer;

  // Legacy authorities embedded in the fabricated pool. The migration overwrites both with the
  // new role keys and never consults them, so they only need to be present in the legacy bytes.
  const legacyOps = Keypair.generate().publicKey;
  const legacyPause = Keypair.generate().publicKey;
  const legacyFeeRecipient = Keypair.generate().publicKey;

  // New role keys supplied to the migration.
  const newPause = Keypair.generate();
  const newUnpause = Keypair.generate();
  const newTreasury = Keypair.generate();
  const newConfigure = Keypair.generate();
  const newWithdrawRecipient = Keypair.generate();

  const tokens = [
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
    Keypair.generate().publicKey,
  ];

  before(async () => {
    // Let bankrun's `start` find the freshly built program binary in target/deploy.
    const deployDir = path.resolve(__dirname, "..", "target", "deploy");
    process.env.SBF_OUT_DIR = deployDir;
    process.env.BPF_OUT_DIR = deployDir;

    programId = new PublicKey(IDL.address);
    context = await start([{ name: "stable_swapper", programId }], []);
    provider = new BankrunProvider(context);
    program = new Program(IDL as StableSwapper, provider);
    payer = provider.wallet.publicKey;

    [pool, poolBump] = PublicKey.findProgramAddressSync(
      [LIQUIDITY_POOL_SEED],
      programId
    );
    [programData] = PublicKey.findProgramAddressSync(
      [programId.toBuffer()],
      BPF_LOADER_UPGRADEABLE
    );
    accountDiscriminator = Buffer.from(
      IDL.accounts.find((a: any) => a.name === "LiquidityPool").discriminator
    );

    // The provider wallet, which pays for every migration here, is the upgrade authority.
    setProgramData(programData, payer);
  });

  // A bankrun context holds a single bank whose blockhash only rolls when the slot moves, and
  // several tests issue byte-identical `migrate` transactions. Sharing a blockhash across them
  // would get the repeat rejected as already-processed before the guard under test ever runs.
  let slot = 1;
  beforeEach(() => {
    context.warpToSlot(BigInt(++slot));
  });

  function setProgramData(address: PublicKey, authority: PublicKey | null) {
    context.setAccount(address, {
      lamports: 1_000_000_000,
      data: programDataBytes(authority),
      owner: BPF_LOADER_UPGRADEABLE,
      executable: false,
      rentEpoch: 0,
    });
  }

  async function seedLegacyPool(overrides: Partial<LegacyFields> = {}) {
    const fields: LegacyFields = {
      ops: legacyOps,
      pause: legacyPause,
      feeRecipient: legacyFeeRecipient,
      tokens,
      feeRate: 30,
      swapsPaused: true,
      liquidityPaused: false,
      bump: poolBump,
      ...overrides,
    };
    const data = buildLegacyPoolData(accountDiscriminator, fields);
    const rent = await context.banksClient.getRent();
    const lamports = Number(rent.minimumBalance(BigInt(data.length)));
    context.setAccount(pool, {
      lamports,
      data,
      owner: programId,
      executable: false,
      rentEpoch: 0,
    });
  }

  function migrate(overrides: MigrateOverrides = {}) {
    return program.methods
      .migrateAuthorities(
        overrides.newPause ?? newPause.publicKey,
        overrides.newUnpause ?? newUnpause.publicKey,
        overrides.newTreasury ?? newTreasury.publicKey,
        overrides.newConfigure ?? newConfigure.publicKey,
        overrides.newWithdrawRecipient ?? newWithdrawRecipient.publicKey
      )
      .accounts({
        pool,
        payer: overrides.payer ?? payer,
        programData: overrides.programData ?? programData,
        systemProgram: SystemProgram.programId,
      })
      .signers(overrides.signers ?? [])
      .rpc();
  }

  function fundSystemAccount(key: PublicKey) {
    context.setAccount(key, {
      lamports: 1_000_000_000,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
      rentEpoch: 0,
    });
  }

  async function fetchPool(): Promise<any> {
    const raw = await context.banksClient.getAccount(pool);
    assert.isNotNull(raw, "pool account missing");
    // Anchor's Program constructor camelCases IDL account names.
    return program.coder.accounts.decode(
      "liquidityPool",
      Buffer.from(raw!.data)
    );
  }

  it("migrates a legacy pool and preserves packed trailing state", async () => {
    await seedLegacyPool();

    await migrate();

    const acct = await fetchPool();
    // New roles applied.
    assert.equal(acct.pauseAuthority.toBase58(), newPause.publicKey.toBase58());
    assert.equal(
      acct.unpauseAuthority.toBase58(),
      newUnpause.publicKey.toBase58()
    );
    assert.equal(
      acct.treasuryAuthority.toBase58(),
      newTreasury.publicKey.toBase58()
    );
    assert.equal(
      acct.configureAuthority.toBase58(),
      newConfigure.publicKey.toBase58()
    );
    // Preserved + new field seeded.
    assert.equal(
      acct.feeRecipient.toBase58(),
      legacyFeeRecipient.toBase58(),
      "fee_recipient must be carried over"
    );
    assert.equal(acct.withdrawRecipients.length, 1);
    assert.equal(
      acct.withdrawRecipients[0].toBase58(),
      newWithdrawRecipient.publicKey.toBase58()
    );
    // Trailing fields read from the packed offset (the bug under test).
    assert.deepEqual(
      acct.supportedTokens.map((t: PublicKey) => t.toBase58()),
      tokens.map((t) => t.toBase58()),
      "packed supported_tokens must be parsed in full"
    );
    assert.equal(
      acct.feeRate.toNumber(),
      30,
      "fee_rate must survive migration"
    );
    assert.equal(acct.swapsPaused, true, "swaps_paused must survive migration");
    assert.equal(acct.liquidityPaused, false);
    assert.equal(
      acct.bump,
      poolBump,
      "bump must survive migration (zero bump would brick the PDA)"
    );
  });

  it("zeroes stale trailing bytes after migration", async () => {
    const data = buildLegacyPoolData(accountDiscriminator, {
      ops: legacyOps,
      pause: legacyPause,
      feeRecipient: legacyFeeRecipient,
      tokens,
      feeRate: 30,
      swapsPaused: true,
      liquidityPaused: false,
      bump: poolBump,
    });
    const legacyPackedEnd = 108 + tokens.length * 32 + 8 + 1 + 1 + 1;
    data.fill(0xff, legacyPackedEnd);
    const rent = await context.banksClient.getRent();
    context.setAccount(pool, {
      lamports: Number(rent.minimumBalance(BigInt(data.length))),
      data,
      owner: programId,
      executable: false,
      rentEpoch: 0,
    });

    await migrate();

    const raw = await context.banksClient.getAccount(pool);
    assert.isNotNull(raw, "pool account missing");
    const body = Buffer.from(raw!.data);
    const packed = await program.coder.accounts.encode(
      "liquidityPool",
      await fetchPool()
    );
    const tail = body.subarray(packed.length);
    assert.isTrue(
      tail.length > 0,
      "expected reserved capacity past the packed struct"
    );
    assert.isTrue(
      tail.every((b) => b === 0),
      "bytes past the packed struct must be zeroed"
    );
  });

  it("rejects a second migration (AlreadyMigrated)", async () => {
    await seedLegacyPool();
    await migrate();

    // The retry must differ from the first transaction, otherwise the SVM rejects it as
    // already-processed (same signers, args, and blockhash) and the guard never runs. A
    // different role key is enough: AlreadyMigrated is checked on the account length,
    // before any of the legacy fields are parsed.
    try {
      await migrate({ newPause: Keypair.generate().publicKey });
      assert.fail("expected AlreadyMigrated");
    } catch (error) {
      assert.include(errText(error), "alreadymigrated");
    }
  });

  it("rejects a caller that is not the upgrade authority", async () => {
    await seedLegacyPool();
    const stranger = Keypair.generate();
    fundSystemAccount(stranger.publicKey);

    try {
      await migrate({ payer: stranger.publicKey, signers: [stranger] });
      assert.fail("expected NotUpgradeAuthority");
    } catch (error) {
      assert.include(errText(error), "notupgradeauthority");
    }

    // The legacy layout must be left intact for a later, properly authorized attempt.
    const raw = await context.banksClient.getAccount(pool);
    assert.equal(raw!.data.length, LEGACY_TOTAL);
  });

  it("rejects program data belonging to another program", async () => {
    await seedLegacyPool();
    // Well-formed and naming the payer as upgrade authority, but recorded for a different
    // program. Only the address constraint separates it from this program's record.
    const [foreign] = PublicKey.findProgramAddressSync(
      [Keypair.generate().publicKey.toBuffer()],
      BPF_LOADER_UPGRADEABLE
    );
    setProgramData(foreign, payer);

    try {
      await migrate({ programData: foreign });
      assert.fail("expected InvalidProgramData");
    } catch (error) {
      assert.include(errText(error), "invalidprogramdata");
    }
  });

  it("rejects a pool whose size is neither the legacy nor the migrated layout", async () => {
    // A wrong-sized account is not the same failure as a re-run, so it must not be reported
    // as AlreadyMigrated.
    const data = Buffer.alloc(LEGACY_TOTAL - 1);
    accountDiscriminator.copy(data, 0);
    const rent = await context.banksClient.getRent();
    context.setAccount(pool, {
      lamports: Number(rent.minimumBalance(BigInt(data.length))),
      data,
      owner: programId,
      executable: false,
      rentEpoch: 0,
    });

    try {
      await migrate();
      assert.fail("expected LegacySizeMismatch");
    } catch (error) {
      assert.include(errText(error), "legacysizemismatch");
    }
  });

  it("rejects a migration that would assign a role to the default pubkey", async () => {
    // Roles self-rotate, so a zero-key role could never be recovered.
    const roles: (keyof MigrateOverrides)[] = [
      "newPause",
      "newUnpause",
      "newTreasury",
      "newConfigure",
    ];

    for (const role of roles) {
      await seedLegacyPool();
      try {
        await migrate({ [role]: PublicKey.default });
        assert.fail(`expected AuthorityNotSet for ${role}`);
      } catch (error) {
        assert.include(errText(error), "authoritynotset", `role: ${role}`);
      }
    }
  });

  it("rejects a legacy pool with a default-pubkey fee_recipient", async () => {
    await seedLegacyPool({ feeRecipient: PublicKey.default });
    try {
      await migrate();
      assert.fail("expected RecipientNotSet");
    } catch (error) {
      assert.include(errText(error), "recipientnotset");
    }
  });

  it("works with an empty legacy supported_tokens vec", async () => {
    // Regression guard for the offset math when len = 0: trailing fields sit right after
    // the 4-byte length prefix.
    await seedLegacyPool({ tokens: [], feeRate: 7, swapsPaused: false });
    await migrate();

    const acct = await fetchPool();
    assert.equal(acct.supportedTokens.length, 0);
    assert.equal(acct.feeRate.toNumber(), 7);
    assert.equal(acct.swapsPaused, false);
    assert.equal(acct.bump, poolBump);
  });
});
