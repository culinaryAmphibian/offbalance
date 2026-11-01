import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { network } from "hardhat";
import { encodeAbiParameters, keccak256, parseEther, toHex, zeroAddress, zeroHash, type Hex } from "viem";

describe("OffBalance lifecycle", async () => {
  const { viem, networkHelpers } = await network.create();
  const [, buyer, p1, p2, p3, outsider] = await viem.getWalletClients();
  const providers = [p1, p2, p3];
  const price = parseEther("1");
  const duration = 60n;
  const output = toHex("verified result");
  const salt = (n: number) => toHex(n, { size: 32 });
  const commitment = (out: Hex, secret: Hex) => keccak256(encodeAbiParameters(
    [{ type: "bytes32" }, { type: "bytes32" }], [keccak256(out), secret],
  ));
  const Status = { PENDING: 0, COMMIT: 2, REVEAL: 3, DELIVERING: 5, PAID: 7, CANCELED: 8, NO_QUORUM: 9 };

  async function deploy() {
    return viem.deployContract("OffBalance");
  }
  let contract: Awaited<ReturnType<typeof deploy>>;
  let stake: bigint;
  beforeEach(async () => {
    contract = await networkHelpers.loadFixture(deploy);
    stake = await contract.read.STAKE();
  });

  const submit = (id = 1n, k = 3n, quorum = 2n, amount = price) =>
    contract.write.submitJob([id, amount, k, quorum, duration, "registry.example/job:v1"],
      { account: buyer.account, value: amount });
  const assign = (id = 1n, selected = providers) =>
    contract.write.assignProviders([id, selected.map(p => p.account.address)]);
  const commit = (provider = p1, out = output, secret = salt(1)) =>
    contract.write.submitCommitment([1n, commitment(out, secret)], { account: provider.account, value: stake });
  const reveal = (provider = p1, out = output, secret = salt(1)) =>
    contract.write.submitReveal([1n, out, secret], { account: provider.account });
  const details = (provider = p1) => contract.read.getProviderCommitment([1n, provider.account.address]);
  const credit = (wallet = buyer) => contract.read.credits([wallet.account.address]);
  const status = () => contract.read.getJobStatus([1n]);
  async function beginReveal() {
    const [, deadline] = await contract.read.getDeadlines([1n]);
    await networkHelpers.time.increaseTo(deadline + 1n);
    return contract.write.startRevealPhase([1n]);
  }
  async function closeReveal() {
    const [, , deadline] = await contract.read.getDeadlines([1n]);
    await networkHelpers.time.increaseTo(deadline + 1n);
    return contract.write.endRevealPhase([1n]);
  }
  async function closeDelivery() {
    const [, , , deadline] = await contract.read.getDeadlines([1n]);
    await networkHelpers.time.increaseTo(deadline + 1n);
    return contract.write.endDeliveryPhase([1n]);
  }
  async function winningJob() {
    await submit();
    await assign();
    for (const [i, provider] of providers.entries()) await commit(provider, output, salt(i));
    await beginReveal();
    for (const [i, provider] of providers.entries()) await reveal(provider, output, salt(i));
    await closeReveal();
  }

  it("submits caller-supplied IDs, exact escrow, initial status and events", async () => {
    await viem.assertions.emitWithArgs(submit(), contract, "JOB_SUBMITTED", [1n]);
    await submit(42n);
    assert.equal(await status(), Status.PENDING);
    assert.equal(await contract.read.getJobStatus([42n]), Status.PENDING);
    assert.deepEqual(await contract.read.getAssignedProviders([1n]), []);
    await viem.assertions.revertWith(submit(), "Job id already used");
  });

  it("rejects zero price, wrong escrow, invalid thresholds and zero duration", async () => {
    const send = (amount: bigint, k: bigint, quorum: bigint, seconds: bigint, value = amount) =>
      contract.write.submitJob([1n, amount, k, quorum, seconds, "img"], { account: buyer.account, value });
    await viem.assertions.revertWith(send(0n, 3n, 2n, duration), "Price must be positive");
    await viem.assertions.revertWith(send(price, 3n, 2n, duration, price - 1n), "Send exact job price");
    for (const [k, quorum] of [[0n, 1n], [3n, 0n], [2n, 3n]])
      await viem.assertions.revertWith(send(price, k, quorum, duration), "Invalid consensus threshold");
    await viem.assertions.revertWith(send(price, 3n, 2n, 0n), "Execution time must be positive");
  });

  it("cancels only pending jobs owned by the buyer and credits the escrow once", async () => {
    await submit();
    await viem.assertions.revertWith(contract.write.cancelJob([1n], { account: outsider.account }), "Only buyer");
    await contract.write.cancelJob([1n], { account: buyer.account });
    assert.equal(await status(), Status.CANCELED);
    assert.equal(await credit(), price);
    await viem.assertions.revertWith(contract.write.cancelJob([1n], { account: buyer.account }), "Job no longer pending");
    await viem.assertions.revertWith(contract.write.cancelJob([999n], { account: buyer.account }), "Unknown job");
    await submit(2n);
    await assign(2n);
    await viem.assertions.revertWith(contract.write.cancelJob([2n], { account: buyer.account }), "Job no longer pending");
  });

  it("assigns exactly k distinct nonzero providers through the server", async () => {
    await submit();
    const addresses = providers.map(p => p.account.address);
    await viem.assertions.revertWith(contract.write.assignProviders([1n, addresses], { account: buyer.account }), "Only server");
    await viem.assertions.revertWith(assign(1n, [p1, p2]), "Must assign exactly k providers");
    await viem.assertions.revertWith(assign(1n, [p1, p1, p3]), "Duplicate provider");
    await viem.assertions.revertWith(contract.write.assignProviders([1n, [zeroAddress, ...addresses.slice(1)]]), "Zero provider address");
    await assign();
    assert.equal(await status(), Status.COMMIT);
    assert.deepEqual((await contract.read.getAssignedProviders([1n])).map(a => a.toLowerCase()), addresses.map(a => a.toLowerCase()));
    await viem.assertions.revertWith(assign(), "Job not awaiting assignment");
  });

  it("accepts one nonempty, exactly staked commitment per assigned provider", async () => {
    await submit();
    await assign();
    await viem.assertions.revertWith(commit(outsider), "Provider not assigned");
    await viem.assertions.revertWith(contract.write.submitCommitment([1n, zeroHash], { account: p1.account, value: stake }), "Empty commitment");
    await viem.assertions.revertWith(contract.write.submitCommitment([1n, salt(1)], { account: p1.account, value: stake - 1n }), "Incorrect stake");
    await commit();
    await viem.assertions.revertWith(commit(), "Already committed");
    const [hash, , , , , deposited] = await details();
    assert.equal(hash, commitment(output, salt(1)));
    assert.equal(deposited, stake);
    await beginReveal();
    await viem.assertions.revertWith(commit(p2), "Not in commit phase");
  });

  it("starts reveal only after the commit deadline and emits the phase event once", async () => {
    await submit();
    await assign();
    await viem.assertions.revertWith(contract.write.startRevealPhase([1n]), "Commit phase not ended");
    await viem.assertions.emitWithArgs(beginReveal(), contract, "REVEAL_PHASE_START", [1n]);
    assert.equal(await status(), Status.REVEAL);
    await viem.assertions.revertWith(contract.write.startRevealPhase([1n]), "Not in commit phase");
  });

  it("rejects wrong-phase, missing, mismatched and duplicate reveals", async () => {
    await submit();
    await assign();
    await viem.assertions.revertWith(reveal(), "Not in reveal phase");
    await commit();
    await beginReveal();
    await viem.assertions.revertWith(reveal(p2), "No commitment");
    await viem.assertions.revertWith(reveal(p1, "0xbb"), "Reveal does not match commitment");
    await viem.assertions.revertWith(reveal(p1, output, salt(2)), "Reveal does not match commitment");
    await viem.assertions.emitWithArgs(reveal(), contract, "REVEALED", [1n, p1.account.address, keccak256(output)]);
    assert.equal((await details())[1], keccak256(output));
    assert.equal((await details())[2], true);
    await viem.assertions.revertWith(reveal(), "Already revealed");
  });

  it("rejects a reveal after the reveal deadline", async () => {
    await submit();
    await assign();
    await commit();
    await beginReveal();
    const [, , deadline] = await contract.read.getDeadlines([1n]);
    await networkHelpers.time.increaseTo(deadline + 1n);
    await viem.assertions.revertWith(reveal(), "Reveal deadline passed");
  });

  it("runs submission through delivery and settlement with receipt authorization", async () => {
    await winningJob();
    assert.equal(await status(), Status.DELIVERING);
    assert.equal((await details())[3], true);
    await viem.assertions.revertWith(contract.write.verifyReceipt([1n, p1.account.address], { account: outsider.account }), "Only server");
    for (const p of [p1, p2]) await contract.write.verifyReceipt([1n, p.account.address]);
    assert.equal((await details())[4], true);
    await viem.assertions.revertWith(contract.write.verifyReceipt([1n, p1.account.address]), "Already delivered");
    await viem.assertions.emitWithArgs(closeDelivery(), contract, "DELIVERED", [1n]);
    assert.equal(await status(), Status.PAID);
    assert.equal(await credit(p1), (price + stake) / 2n + stake);
    assert.equal(await credit(p2), (price + stake) / 2n + stake);
    assert.equal(await credit(p3), 0n);
    for (const p of providers) assert.equal((await details(p))[5], 0n);
  });

  it("accepts exactly quorum matching reveals and excludes the conflicting provider", async () => {
    await submit();
    await assign();
    for (const [i, p] of providers.entries()) await commit(p, i === 2 ? "0xbb" : output, salt(i));
    await beginReveal();
    for (const [i, p] of providers.entries()) await reveal(p, i === 2 ? "0xbb" : output, salt(i));
    await viem.assertions.emitWithArgs(closeReveal(), contract, "CONSENSUS_REACHED", [1n, keccak256(output), 2n]);
    assert.deepEqual(await Promise.all(providers.map(async p => (await details(p))[3])), [true, true, false]);
    await viem.assertions.revertWith(contract.write.verifyReceipt([1n, p3.account.address]), "Provider did not agree with consensus");
  });

  it("without quorum pays revealing providers and redistributes an unrevealed stake", async () => {
    await submit();
    await assign();
    await commit(p1, "0xaa");
    await commit(p2, "0xbb");
    await commit(p3, "0xcc");
    await beginReveal();
    await reveal(p1, "0xaa");
    await reveal(p2, "0xbb");
    await viem.assertions.emitWithArgs(closeReveal(), contract, "NO_QUORUM", [1n]);
    assert.equal(await status(), Status.NO_QUORUM);
    assert.equal(await credit(), 0n);
    for (const p of [p1, p2]) assert.equal(await credit(p), (price + stake) / 2n + stake);
    assert.equal(await credit(p3), 0n);
    for (const p of providers) assert.equal((await details(p))[5], 0n);
    await viem.assertions.revertWith(contract.write.endDeliveryPhase([1n]), "Not in delivery phase");
  });

  it("refunds the buyer when nobody reveals and clears deposited stakes", async () => {
    await submit();
    await assign();
    await commit(p1);
    await commit(p2);
    await beginReveal();
    await closeReveal();
    assert.equal(await status(), Status.NO_QUORUM);
    assert.equal(await credit(), price);
    for (const p of providers) {
      assert.equal(await credit(p), 0n);
      assert.equal((await details(p))[5], 0n);
    }
  });

  it("ends reveal only in its phase and after its deadline", async () => {
    await submit();
    await assign();
    await viem.assertions.revertWith(contract.write.endRevealPhase([1n]), "Not in reveal phase");
    await beginReveal();
    await viem.assertions.revertWith(contract.write.endRevealPhase([1n]), "Reveal phase not ended");
    await closeReveal();
    await viem.assertions.revertWith(contract.write.endRevealPhase([1n]), "Not in reveal phase");
  });

  it("rejects delivery receipts outside the phase or after its deadline", async () => {
    await viem.assertions.revertWith(contract.write.verifyReceipt([1n, p1.account.address]), "Not in delivery phase");
    await winningJob();
    const [, , , deadline] = await contract.read.getDeadlines([1n]);
    await networkHelpers.time.increaseTo(deadline + 1n);
    await viem.assertions.revertWith(contract.write.verifyReceipt([1n, p1.account.address]), "Delivery window ended");
  });

  it("ends delivery only in its phase and after its deadline", async () => {
    await viem.assertions.revertWith(contract.write.endDeliveryPhase([1n]), "Not in delivery phase");
    await winningJob();
    await viem.assertions.revertWith(contract.write.endDeliveryPhase([1n]), "Delivery window not ended");
    await closeDelivery();
    assert.equal(await credit(), price);
    await viem.assertions.revertWith(contract.write.endDeliveryPhase([1n]), "Not in delivery phase");
  });

  it("withdraws the credited balance exactly once", async () => {
    await submit();
    await contract.write.cancelJob([1n], { account: buyer.account });
    await viem.assertions.revertWith(contract.write.withdraw({ account: outsider.account }), "No credit");
    await viem.assertions.balancesHaveChanged(contract.write.withdraw({ account: buyer.account }), [{ address: buyer.account.address, amount: price }]);
    assert.equal(await credit(), 0n);
    await viem.assertions.revertWith(contract.write.withdraw({ account: buyer.account }), "No credit");
  });

  it("exposes default, committed and revealed provider data", async () => {
    await submit();
    assert.deepEqual(await details(), [zeroHash, zeroHash, false, false, false, 0n]);
    await assign();
    await commit();
    assert.deepEqual(await details(), [commitment(output, salt(1)), zeroHash, false, false, false, stake]);
    await beginReveal();
    await reveal();
    assert.deepEqual(await details(), [commitment(output, salt(1)), keccak256(output), true, false, false, stake]);
  });

  it("distributes rounding dust to the first winner without leaving escrow uncredited", async () => {
    const amount = 1001n;
    await submit(1n, 3n, 2n, amount);
    await assign();
    for (const [i, p] of providers.entries()) await commit(p, output, salt(i));
    await beginReveal();
    for (const [i, p] of providers.entries()) await reveal(p, output, salt(i));
    await closeReveal();
    for (const p of providers) await contract.write.verifyReceipt([1n, p.account.address]);
    await closeDelivery();
    assert.equal(await credit(p1), amount / 3n + amount % 3n + stake);
    for (const p of [p2, p3]) assert.equal(await credit(p), amount / 3n + stake);
    assert.equal((await Promise.all(providers.map(credit))).reduce((a, b) => a + b, 0n), amount + 3n * stake);
  });
});
