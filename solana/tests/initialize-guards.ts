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
  let pool: PublicKey;
  let payer: PublicKey;

  beforeEach(async () => {
    // A fresh SVM per test: `initialize` only succeeds while the pool PDA is empty.
    const deployDir = path.resolve(__dirname, "..", "target", "deploy");
    process.env.SBF_OUT_DIR = deployDir;
    process.env.BPF_OUT_DIR = deployDir;

    const programId = new PublicKey(IDL.address);
    context = await start([{ name: "stable_swapper", programId }], []);
    const provider = new BankrunProvider(context);
    program = new Program(IDL as StableSwapper, provider);
    payer = provider.wallet.publicKey;
    [pool] = PublicKey.findProgramAddressSync([LIQUIDITY_POOL_SEED], programId);
  });

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

  function initialize(roles: InitializeRoles) {
    return program.methods
      .initialize(new BN(0))
      .accounts({
        pool,
        payer,
        ...roles,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
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
      try {
        await initialize({ ...defaultRoles(), [role]: PublicKey.default });
        assert.fail(`expected ${expected} for ${role}`);
      } catch (error) {
        assert.include(errText(error), expected);
      }

      const acct = await context.banksClient.getAccount(pool);
      assert.isNull(acct, "pool must not be created by a rejected initialize");
    });
  }
});
