/**
 * Guards on `initialize` that cannot be exercised against the shared localnet pool in
 * stable-swapper.ts: the pool is a PDA of a fixed seed, so it can only be initialized once per
 * program. Each test here gets a fresh `solana-bankrun` context with no pool account, which
 * lets us assert that a bad role key is rejected at creation time rather than baked into a
 * pool that can never be repaired.
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

const LIQUIDITY_POOL_SEED = Buffer.from("liquidity_pool");
const BPF_LOADER_UPGRADEABLE = new PublicKey(
  "BPFLoaderUpgradeab1e11111111111111111111111"
);

// `solana-bankrun` registers programs under the non-upgradeable loader, so no ProgramData
// account exists in the test SVM. `initialize` reads one to find the upgrade authority, so
// each test installs it by hand, exactly as the BPF upgradeable loader would lay it out:
// bincode-encoded `UpgradeableLoaderState::ProgramData` -- a u32 variant tag (3), a u64 slot,
// then `Option<Pubkey>` as a one-byte tag plus the key. A real account carries the program ELF
// after this header; the extra bytes are ignored either way.
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

interface InitializeRoles {
  pauseAuthority: PublicKey;
  unpauseAuthority: PublicKey;
  treasuryAuthority: PublicKey;
  configureAuthority: PublicKey;
  feeRecipient: PublicKey;
  withdrawRecipient: PublicKey;
}

function errText(error: any): string {
  const logs = Array.isArray(error?.logs) ? error.logs.join("\n") : "";
  return `${logs}\n${error?.transactionMessage ?? ""}\n${error}`.toLowerCase();
}

describe("initialize role guards (bankrun)", () => {
  let context: ProgramTestContext;
  let program: Program<StableSwapper>;
  let programId: PublicKey;
  let pool: PublicKey;
  let programData: PublicKey;
  let payer: PublicKey;

  beforeEach(async () => {
    // A fresh SVM per test: `initialize` only succeeds while the pool PDA is empty.
    const deployDir = path.resolve(__dirname, "..", "target", "deploy");
    process.env.SBF_OUT_DIR = deployDir;
    process.env.BPF_OUT_DIR = deployDir;

    programId = new PublicKey(IDL.address);
    context = await start([{ name: "stable_swapper", programId }], []);
    const provider = new BankrunProvider(context);
    program = new Program(IDL as StableSwapper, provider);
    payer = provider.wallet.publicKey;
    [pool] = PublicKey.findProgramAddressSync([LIQUIDITY_POOL_SEED], programId);
    [programData] = PublicKey.findProgramAddressSync(
      [programId.toBuffer()],
      BPF_LOADER_UPGRADEABLE
    );

    // Happy path: the provider wallet, which pays for every test here, is the upgrade authority.
    setProgramData(programData, payer);
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

  function fundSystemAccount(key: PublicKey) {
    context.setAccount(key, {
      lamports: 1_000_000_000,
      data: Buffer.alloc(0),
      owner: SystemProgram.programId,
      executable: false,
      rentEpoch: 0,
    });
  }

  function defaultRoles(): InitializeRoles {
    return {
      pauseAuthority: Keypair.generate().publicKey,
      unpauseAuthority: Keypair.generate().publicKey,
      treasuryAuthority: Keypair.generate().publicKey,
      configureAuthority: Keypair.generate().publicKey,
      feeRecipient: Keypair.generate().publicKey,
      withdrawRecipient: Keypair.generate().publicKey,
    };
  }

  interface InitializeOverrides {
    payer?: PublicKey;
    programData?: PublicKey;
    signers?: Keypair[];
  }

  function initialize(
    roles: InitializeRoles,
    overrides: InitializeOverrides = {}
  ) {
    return program.methods
      .initialize(new BN(0))
      .accounts({
        pool,
        payer: overrides.payer ?? payer,
        programData: overrides.programData ?? programData,
        ...roles,
        systemProgram: SystemProgram.programId,
      })
      .signers(overrides.signers ?? [])
      .rpc();
  }

  async function assertInitializeFails(
    expected: string,
    roles: InitializeRoles,
    overrides: InitializeOverrides = {}
  ) {
    // Tracked with a flag rather than `assert.fail` inside the `try`: the assertion message
    // would contain `expected` and the `catch` below would then match against itself.
    let succeeded = false;
    try {
      await initialize(roles, overrides);
      succeeded = true;
    } catch (error) {
      assert.include(errText(error), expected);
    }
    assert.isFalse(succeeded, `initialize succeeded, expected ${expected}`);

    const acct = await context.banksClient.getAccount(pool);
    assert.isNull(acct, "pool must not be created by a rejected initialize");
  }

  it("initializes with distinct role keys", async () => {
    const roles = defaultRoles();
    await initialize(roles);

    const acct = await program.account.liquidityPool.fetch(pool);
    assert.equal(
      acct.pauseAuthority.toBase58(),
      roles.pauseAuthority.toBase58()
    );
    assert.equal(
      acct.configureAuthority.toBase58(),
      roles.configureAuthority.toBase58()
    );
    assert.equal(acct.withdrawRecipients.length, 1);
    assert.equal(
      acct.withdrawRecipients[0].toBase58(),
      roles.withdrawRecipient.toBase58()
    );
  });

  const zeroKeyCases: [keyof InitializeRoles, string][] = [
    ["pauseAuthority", "authoritynotset"],
    ["unpauseAuthority", "authoritynotset"],
    ["treasuryAuthority", "authoritynotset"],
    ["configureAuthority", "authoritynotset"],
    ["withdrawRecipient", "withdrawrecipientnotset"],
  ];

  for (const [role, expected] of zeroKeyCases) {
    it(`rejects the default pubkey for ${role}`, async () => {
      await assertInitializeFails(expected, {
        ...defaultRoles(),
        [role]: PublicKey.default,
      });
    });
  }

  // The pool PDA has a fixed seed and no instruction can close it, so an unguarded
  // `initialize` would let the first caller squat the only pool the program can ever have.
  describe("upgrade authority gate", () => {
    it("rejects a payer that is not the upgrade authority", async () => {
      const squatter = Keypair.generate();
      fundSystemAccount(squatter.publicKey);

      await assertInitializeFails("notupgradeauthority", defaultRoles(), {
        payer: squatter.publicKey,
        signers: [squatter],
      });
    });

    it("rejects an immutable program", async () => {
      setProgramData(programData, null);

      await assertInitializeFails("notupgradeauthority", defaultRoles());
    });

    it("rejects program data belonging to another program", async () => {
      // A well-formed ProgramData account naming the payer as upgrade authority, but recording
      // it for a different program. Only the address constraint separates it from the real one.
      const [foreign] = PublicKey.findProgramAddressSync(
        [Keypair.generate().publicKey.toBuffer()],
        BPF_LOADER_UPGRADEABLE
      );
      setProgramData(foreign, payer);

      await assertInitializeFails("invalidprogramdata", defaultRoles(), {
        programData: foreign,
      });
    });
  });
});
