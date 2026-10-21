'use strict';
// make sure hardhat, hardhat-ether, and hardhat toolbox viem are installed
// cd blockchain && npx hardhat compile
// run with node --test <filename>
import {test, before, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import ethers from 'hardhat';

const Status = Object.freeze({
  JOB_SUBMITTED: 0,
  PROVIDER_SELECTED: 1, // Assignment immediately transitions to COMMIT
  COMMIT: 2,
  REVEAL: 3,
  CONSENSUS: 4,       // Transient inside endRevealPhase; asserted via event
  DELIVERING: 5,
  DELIVERED: 6,       // Transient inside endDeliveryPhase; asserted via event
  PAID: 7,
  CANCELED: 8,
  NO_QUORUM: 9,
});

const REVEAL_WINDOW = 120;
const DELIVERY_WINDOW = 300;
const ETHER = ethers.parseEther;

let factory;
let accounts;
let server;
let buyer;
let p1;
let p2;
let p3;
let outsider;
let contract;

before(async () => {
  factory = await ethers.getContractFactory('OffBalance');
  accounts = await ethers.getSigners();
  [server, buyer, p1, p2, p3, outsider] = accounts;
});

beforeEach(async () => {
  contract = await factory.deploy();
  await contract.waitForDeployment();
});

function bytes(s) {
  return ethers.toUtf8Bytes(s);
}

function hashOutput(output) {
  return ethers.keccak256(output);
}

function commitment(output, salt) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'bytes32'],
      [hashOutput(output), salt]
    )
  );
}

function salt(label) {
  return ethers.id(label);
}

async function rejects(promise, reason) {
  await assert.rejects(
    promise,
    reason ? new RegExp(reason) : undefined
  );
}

async function advance(seconds) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

async function status(jobId) {
  return Number(await contract.getJobStatus(jobId));
}

async function submitJob(opts = {}) {
  const price = opts.price ?? ETHER('1');
  const stake = opts.stake ?? ETHER('0.1');
  const k = opts.k ?? 2;
  const quorum = opts.quorum ?? 3;
  const executionTime = opts.executionTime ?? 30;

  const tx = await contract.connect(opts.buyer ?? buyer).submitJob(
    price,
    stake,
    k,
    quorum,
    executionTime,
    opts.image ?? 'registry.example/job:v1',
    { value: opts.value ?? price }
  );

  const receipt = await tx.wait();

  const parsed = receipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((event) => event?.name === 'JOB_SUBMITTED');

  assert.ok(parsed, 'JOB_SUBMITTED event emitted');

  return {
    id: parsed.args.jobId,
    price,
    stake,
    k,
    quorum,
    executionTime,
  };
}

async function assign(job, providers = [p1, p2, p3]) {
  return contract.connect(server).assignProviders(
    job.id,
    providers.map((p) => p.address)
  );
}

async function commit(
  job,
  provider,
  output,
  secretSalt = salt(provider.address)
) {
  await contract.connect(provider).submitCommitment(
    job.id,
    commitment(output, secretSalt),
    { value: job.stake }
  );

  return secretSalt;
}

async function beginReveal(job) {
  await advance(job.executionTime + 1);
  await contract.startRevealPhase(job.id);
}

async function closeReveal(job) {
  await advance(REVEAL_WINDOW + 1);
  return contract.endRevealPhase(job.id);
}

async function closeDelivery(job) {
  await advance(DELIVERY_WINDOW + 1);
  return contract.endDeliveryPhase(job.id);
}

async function eventNames(txPromise) {
  const receipt = await (await txPromise).wait();

  return receipt.logs
    .map((log) => {
      try {
        return contract.interface.parseLog(log)?.name;
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

async function runWinningJob({
  k = 2,
  quorum = 3,
  winners = [p1, p2],
  price = ETHER('1'),
} = {}) {
  const job = await submitJob({ k, quorum, price });
  const ps = [p1, p2, p3].slice(0, quorum);

  await assign(job, ps);

  const outWin = bytes('approved artifact: report-2026-10');
  const outLose = bytes('different artifact');
  const secrets = new Map();

  for (let i = 0; i < ps.length; i++) {
    const provider = ps[i];

    const output = winners.some(
      (w) => w.address === provider.address
    )
      ? outWin
      : outLose;

    secrets.set(provider.address, {
      output,
      salt: await commit(
        job,
        provider,
        output,
        salt(`secret-${provider.address}`)
      ),
    });
  }

  await beginReveal(job);

  for (const provider of ps) {
    const { output, salt: secret } = secrets.get(provider.address);

    await contract.connect(provider).submitReveal(
      job.id,
      output,
      secret
    );
  }

  const revealEvents = await eventNames(closeReveal(job));

  return {
    job,
    ps,
    outWin,
    outLose,
    secrets,
    revealEvents,
  };
}

test(
  'submitJob: valid escrow, initial status, event, and sequential IDs',
  async () => {
    const first = await submitJob();
    const second = await submitJob({ price: ETHER('0.25') });

    assert.equal(await status(first.id), Status.JOB_SUBMITTED);
    assert.equal(await status(second.id), Status.JOB_SUBMITTED);
    assert.equal(second.id, first.id + 1n);

    assert.deepEqual(
      await contract.getAssignedProviders(first.id),
      []
    );
  }
);

test(
  'submitJob rejects zero price, wrong escrow, zero stake, invalid threshold, and zero duration',
  async () => {
    const price = ETHER('1');
    const stake = ETHER('0.1');

    await rejects(
      contract.connect(buyer).submitJob(
        0, stake, 1, 1, 10, 'img',
        { value: 0 }
      ),
      'Price must be positive'
    );

    await rejects(
      contract.connect(buyer).submitJob(
        price, stake, 1, 1, 10, 'img',
        { value: 1 }
      ),
      'Send exact job price'
    );

    await rejects(
      contract.connect(buyer).submitJob(
        price, 0, 1, 1, 10, 'img',
        { value: price }
      ),
      'Stake must be positive'
    );

    await rejects(
      contract.connect(buyer).submitJob(
        price, stake, 0, 1, 10, 'img',
        { value: price }
      ),
      'Invalid consensus threshold'
    );

    await rejects(
      contract.connect(buyer).submitJob(
        price, stake, 2, 1, 10, 'img',
        { value: price }
      ),
      'Invalid consensus threshold'
    );

    await rejects(
      contract.connect(buyer).submitJob(
        price, stake, 1, 1, 0, 'img',
        { value: price }
      ),
      'Execution time must be positive'
    );
  }
);

test(
  'cancelJob: buyer can cancel only a pending job and receive a pull-payment credit',
  async () => {
    const job = await submitJob();

    await rejects(
      contract.connect(outsider).cancelJob(job.id),
      'Only buyer'
    );

    await contract.connect(buyer).cancelJob(job.id);

    assert.equal(await status(job.id), Status.CANCELED);
    assert.equal(
      await contract.credits(buyer.address),
      job.price
    );

    await rejects(
      contract.connect(buyer).cancelJob(job.id),
      'Job no longer pending'
    );

    await rejects(
      contract.connect(buyer).cancelJob(99999),
      'Unknown job'
    );
  }
);

test(
  'assignProviders: server-only, exact quorum, no zero/duplicate addresses, correct status and getter',
  async () => {
    const job = await submitJob({ k: 2, quorum: 3 });

    await rejects(
      contract.connect(buyer).assignProviders(
        job.id,
        [p1.address, p2.address, p3.address]
      ),
      'Only server'
    );

    await rejects(
      contract.assignProviders(
        job.id,
        [p1.address, p2.address]
      ),
      'Must assign exact quorum'
    );

    await rejects(
      contract.assignProviders(
        job.id,
        [p1.address, p1.address, p3.address]
      ),
      'Duplicate provider'
    );

    await rejects(
      contract.assignProviders(
        job.id,
        [ethers.ZeroAddress, p2.address, p3.address]
      ),
      'Zero provider address'
    );

    await assign(job);

    assert.equal(await status(job.id), Status.COMMIT);

    assert.deepEqual(
      await contract.getAssignedProviders(job.id),
      [p1.address, p2.address, p3.address]
    );

    await rejects(
      assign(job),
      'Job not awaiting assignment'
    );
  }
);

test(
  'submitCommitment: only assigned providers, nonzero commitment, exact stake, once, and before deadline',
  async () => {
    const job = await submitJob({ k: 1, quorum: 2 });

    await assign(job, [p1, p2]);

    await rejects(
      contract.connect(outsider).submitCommitment(
        job.id,
        salt('x'),
        { value: job.stake }
      ),
      'Provider not assigned'
    );

    await rejects(
      contract.connect(p1).submitCommitment(
        job.id,
        ethers.ZeroHash,
        { value: job.stake }
      ),
      'Empty commitment'
    );

    await rejects(
      contract.connect(p1).submitCommitment(
        job.id,
        salt('x'),
        { value: job.stake - 1n }
      ),
      'Incorrect stake'
    );

    const output = bytes('provider output');
    const secret = await commit(job, p1, output);

    await rejects(
      contract.connect(p1).submitCommitment(
        job.id,
        salt('replacement'),
        { value: job.stake }
      ),
      'Already committed'
    );

    const c = await contract.getProviderCommitment(
      job.id,
      p1.address
    );

    assert.equal(
      c.commitmentHash,
      commitment(output, secret)
    );

    assert.equal(c.stake, job.stake);

    await advance(job.executionTime + 1);
    await contract.startRevealPhase(job.id);

    await rejects(
      contract.connect(p2).submitCommitment(
        job.id,
        salt('late'),
        { value: job.stake }
      ),
      'Not in commit phase'
    );
  }
);

test(
  'startRevealPhase: cannot transition early or twice; emits phase event',
  async () => {
    const job = await submitJob({
      k: 1,
      quorum: 2,
      executionTime: 20,
    });

    await assign(job, [p1, p2]);

    await rejects(
      contract.startRevealPhase(job.id),
      'Commit phase not ended'
    );

    await advance(job.executionTime + 1);

    const events = await eventNames(
      contract.startRevealPhase(job.id)
    );

    assert.ok(events.includes('REVEAL_PHASE_START'));
    assert.equal(await status(job.id), Status.REVEAL);

    await rejects(
      contract.startRevealPhase(job.id),
      'Not in commit phase'
    );
  }
);

test(
  'submitReveal: rejects wrong phase, missing commitment, wrong output/salt, and duplicate reveal',
  async () => {
    const job = await submitJob({ k: 1, quorum: 2 });

    await assign(job, [p1, p2]);

    const output = bytes('correct output');
    const secret = salt('correct secret');

    await rejects(
      contract.connect(p1).submitReveal(
        job.id,
        output,
        secret
      ),
      'Not in reveal phase'
    );

    await commit(job, p1, output, secret);
    await beginReveal(job);

    await rejects(
      contract.connect(p2).submitReveal(
        job.id,
        output,
        secret
      ),
      'No commitment'
    );

    await rejects(
      contract.connect(p1).submitReveal(
        job.id,
        bytes('tampered output'),
        secret
      ),
      'Reveal does not match commitment'
    );

    await rejects(
      contract.connect(p1).submitReveal(
        job.id,
        output,
        salt('wrong secret')
      ),
      'Reveal does not match commitment'
    );

    const events = await eventNames(
      contract.connect(p1).submitReveal(
        job.id,
        output,
        secret
      )
    );

    assert.ok(events.includes('REVEALED'));

    const c = await contract.getProviderCommitment(
      job.id,
      p1.address
    );

    assert.equal(c.outputHash, hashOutput(output));
    assert.equal(c.revealed, true);

    await rejects(
      contract.connect(p1).submitReveal(
        job.id,
        output,
        secret
      ),
      'Already revealed'
    );
  }
);

test(
  'submitReveal rejects a reveal after the reveal deadline',
  async () => {
    const job = await submitJob({ k: 1, quorum: 2 });

    await assign(job, [p1, p2]);

    const output = bytes('output');
    const secret = await commit(job, p1, output);

    await beginReveal(job);
    await advance(REVEAL_WINDOW + 1);

    await rejects(
      contract.connect(p1).submitReveal(
        job.id,
        output,
        secret
      ),
      'Reveal deadline passed'
    );
  }
);

test(
  'successful lifecycle: JOB_SUBMITTED -> COMMIT -> REVEAL -> DELIVERING -> PAID',
  async () => {
    const job = await submitJob({
      k: 2,
      quorum: 3,
      price: ETHER('1'),
    });

    assert.equal(await status(job.id), Status.JOB_SUBMITTED);

    await assign(job);

    assert.equal(await status(job.id), Status.COMMIT);

    const common = bytes('validated output bundle');
    const other = bytes('different output bundle');

    const s1 = await commit(
      job, p1, common, salt('p1-salt')
    );

    const s2 = await commit(
      job, p2, common, salt('p2-salt')
    );

    const s3 = await commit(
      job, p3, other, salt('p3-salt')
    );

    await beginReveal(job);

    assert.equal(await status(job.id), Status.REVEAL);

    await contract.connect(p1).submitReveal(
      job.id, common, s1
    );

    await contract.connect(p2).submitReveal(
      job.id, common, s2
    );

    await contract.connect(p3).submitReveal(
      job.id, other, s3
    );

    const events = await eventNames(closeReveal(job));

    assert.equal(await status(job.id), Status.DELIVERING);

    assert.ok(
      events.includes('CONSENSUS_VERIFICATION_START')
    );

    assert.ok(events.includes('CONSENSUS_REACHED'));
    assert.ok(events.includes('DELIVERY_PHASE_START'));

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p1.address
      )).winning,
      true
    );

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p2.address
      )).winning,
      true
    );

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p3.address
      )).winning,
      false
    );

    await rejects(
      contract.connect(outsider).verifyReceipt(
        job.id,
        p1.address
      ),
      'Only server'
    );

    await rejects(
      contract.verifyReceipt(job.id, p3.address),
      'Provider is not a winner'
    );

    await contract.verifyReceipt(job.id, p1.address);
    await contract.verifyReceipt(job.id, p2.address);

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p1.address
      )).delivered,
      true
    );

    await rejects(
      contract.verifyReceipt(job.id, p1.address),
      'Already delivered'
    );

    const payoutEvents = await eventNames(
      closeDelivery(job)
    );

    assert.equal(await status(job.id), Status.PAID);

    assert.ok(payoutEvents.includes('PAID'));
    assert.ok(payoutEvents.includes('SLASHED'));
    assert.ok(payoutEvents.includes('DELIVERED'));

    assert.equal(
      await contract.credits(p1.address),
      job.price / 2n + job.stake
    );

    assert.equal(
      await contract.credits(p2.address),
      job.price / 2n + job.stake
    );

    assert.equal(
      await contract.credits(p3.address),
      0n
    );

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p1.address
      )).stake,
      0n
    );

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p3.address
      )).stake,
      0n
    );
  }
);

test(
  'consensus accepts exactly k matching providers and excludes a conflicting reveal',
  async () => {
    const job = await submitJob({ k: 2, quorum: 3 });

    await assign(job);

    const a = bytes('answer A');
    const b = bytes('answer B');

    const s1 = await commit(job, p1, a, salt('a1'));
    const s2 = await commit(job, p2, a, salt('a2'));
    const s3 = await commit(job, p3, b, salt('b3'));

    await beginReveal(job);

    await contract.connect(p1).submitReveal(job.id, a, s1);
    await contract.connect(p2).submitReveal(job.id, a, s2);
    await contract.connect(p3).submitReveal(job.id, b, s3);

    const events = await eventNames(closeReveal(job));
    const reached = events.includes('CONSENSUS_REACHED');

    assert.equal(reached, true);

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p1.address
      )).winning,
      true
    );

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p2.address
      )).winning,
      true
    );

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p3.address
      )).winning,
      false
    );
  }
);

test(
  'no quorum: buyer refunded, no provider rewarded, all submitted stakes slashed',
  async () => {
    const job = await submitJob({ k: 2, quorum: 3 });

    await assign(job);

    const a = bytes('result A');
    const b = bytes('result B');

    const s1 = await commit(job, p1, a, salt('nq1'));
    const s2 = await commit(job, p2, b, salt('nq2'));

    // p3 does not commit and has no stake to forfeit.
    await beginReveal(job);

    await contract.connect(p1).submitReveal(job.id, a, s1);
    await contract.connect(p2).submitReveal(job.id, b, s2);

    const events = await eventNames(closeReveal(job));

    assert.equal(await status(job.id), Status.NO_QUORUM);
    assert.ok(events.includes('NO_QUORUM'));

    assert.equal(
      await contract.credits(buyer.address),
      job.price
    );

    assert.equal(await contract.credits(p1.address), 0n);
    assert.equal(await contract.credits(p2.address), 0n);

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p1.address
      )).stake,
      0n
    );

    assert.equal(
      (await contract.getProviderCommitment(
        job.id, p2.address
      )).stake,
      0n
    );

    await rejects(
      contract.endDeliveryPhase(job.id),
      'Not in delivery phase'
    );
  }
);

test(
  'zero reveals also ends in NO_QUORUM and refunds the buyer',
  async () => {
    const job = await submitJob({ k: 1, quorum: 2 });

    await assign(job, [p1, p2]);

    await commit(
      job, p1, bytes('never revealed'), salt('nr1')
    );

    await commit(
      job, p2, bytes('also never revealed'), salt('nr2')
    );

    await beginReveal(job);
    await closeReveal(job);

    assert.equal(await status(job.id), Status.NO_QUORUM);

    assert.equal(
      await contract.credits(buyer.address),
      job.price
    );

    assert.equal(await contract.credits(p1.address), 0n);
    assert.equal(await contract.credits(p2.address), 0n);
  }
);

test(
  'endRevealPhase rejects calls before deadline and outside reveal phase',
  async () => {
    const job = await submitJob({ k: 1, quorum: 2 });

    await assign(job, [p1, p2]);

    await rejects(
      contract.endRevealPhase(job.id),
      'Not in reveal phase'
    );

    await beginReveal(job);

    await rejects(
      contract.endRevealPhase(job.id),
      'Reveal phase not ended'
    );

    await closeReveal(job);

    await rejects(
      contract.endRevealPhase(job.id),
      'Not in reveal phase'
    );
  }
);

test(
  'verifyReceipt rejects wrong phase and expired delivery window',
  async () => {
    const job = await submitJob({ k: 1, quorum: 2 });

    await assign(job, [p1, p2]);

    await rejects(
      contract.verifyReceipt(job.id, p1.address),
      'Not in delivery phase'
    );

    const out = bytes('same answer');

    const s1 = await commit(
      job, p1, out, salt('vr1')
    );

    const s2 = await commit(
      job, p2, out, salt('vr2')
    );

    await beginReveal(job);

    await contract.connect(p1).submitReveal(
      job.id, out, s1
    );

    await contract.connect(p2).submitReveal(
      job.id, out, s2
    );

    await closeReveal(job);
    await advance(DELIVERY_WINDOW + 1);

    await rejects(
      contract.verifyReceipt(job.id, p1.address),
      'Delivery window ended'
    );
  }
);

test(
  'endDeliveryPhase rejects early and outside delivery phase',
  async () => {
    const job = await submitJob({ k: 1, quorum: 2 });

    await assign(job, [p1, p2]);

    await rejects(
      contract.endDeliveryPhase(job.id),
      'Not in delivery phase'
    );

    const out = bytes('same answer');

    const s1 = await commit(
      job, p1, out, salt('ed1')
    );

    const s2 = await commit(
      job, p2, out, salt('ed2')
    );

    await beginReveal(job);

    await contract.connect(p1).submitReveal(
      job.id, out, s1
    );

    await contract.connect(p2).submitReveal(
      job.id, out, s2
    );

    await closeReveal(job);

    await rejects(
      contract.endDeliveryPhase(job.id),
      'Delivery window not ended'
    );

    await closeDelivery(job);

    await rejects(
      contract.endDeliveryPhase(job.id),
      'Not in delivery phase'
    );
  }
);

test(
  'withdraw pays credited balance and clears it; zero-credit withdrawal reverts',
  async () => {
    const job = await submitJob();

    await contract.connect(buyer).cancelJob(job.id);

    await rejects(
      contract.connect(outsider).withdraw(),
      'No credit'
    );

    const before = await ethers.provider.getBalance(
      buyer.address
    );

    const tx = await contract.connect(buyer).withdraw();
    const receipt = await tx.wait();

    const gasPrice =
      receipt.gasPrice ?? receipt.effectiveGasPrice;

    const gas = receipt.gasUsed * gasPrice;

    const after = await ethers.provider.getBalance(
      buyer.address
    );

    assert.equal(after - before, job.price - gas);

    assert.equal(
      await contract.credits(buyer.address),
      0n
    );

    await rejects(
      contract.connect(buyer).withdraw(),
      'No credit'
    );
  }
);

test(
  'getJobStatus, getAssignedProviders, and getProviderCommitment expose expected view data',
  async () => {
    const job = await submitJob({ k: 1, quorum: 2 });

    assert.equal(
      await status(job.id),
      Status.JOB_SUBMITTED
    );

    assert.deepEqual(
      await contract.getAssignedProviders(job.id),
      []
    );

    const empty = await contract.getProviderCommitment(
      job.id,
      p1.address
    );

    assert.equal(empty.commitmentHash, ethers.ZeroHash);
    assert.equal(empty.outputHash, ethers.ZeroHash);
    assert.equal(empty.revealed, false);
    assert.equal(empty.winning, false);
    assert.equal(empty.delivered, false);
    assert.equal(empty.stake, 0n);

    await assign(job, [p1, p2]);

    const out = bytes('getter output');

    const secret = await commit(
      job, p1, out, salt('getter salt')
    );

    const committed = await contract.getProviderCommitment(
      job.id,
      p1.address
    );

    assert.equal(
      committed.commitmentHash,
      commitment(out, secret)
    );

    assert.equal(committed.stake, job.stake);

    await beginReveal(job);

    await contract.connect(p1).submitReveal(
      job.id, out, secret
    );

    const revealed = await contract.getProviderCommitment(
      job.id,
      p1.address
    );

    assert.equal(
      revealed.outputHash,
      hashOutput(out)
    );

    assert.equal(revealed.revealed, true);
  }
);

test(
  'non-divisible price leaves only the integer-division remainder uncredited',
  async () => {
    const price = 1001n;

    const job = await submitJob({
      k: 2,
      quorum: 3,
      price,
    });

    await assign(job);

    const out = bytes('same output');
    const secrets = [];

    for (const [i, provider] of [p1, p2, p3].entries()) {
      secrets.push(
        await commit(
          job,
          provider,
          out,
          salt(`remainder-${i}`)
        )
      );
    }

    await beginReveal(job);

    for (const [i, provider] of [p1, p2, p3].entries()) {
      await contract.connect(provider).submitReveal(
        job.id,
        out,
        secrets[i]
      );
    }

    await closeReveal(job);
    await closeDelivery(job);

    const total =
      (await contract.credits(p1.address)) +
      (await contract.credits(p2.address)) +
      (await contract.credits(p3.address));

    assert.equal(
      total,
      (price / 3n) * 3n + job.stake * 3n
    );

    assert.equal(
      price - (price / 3n) * 3n,
      2n
    );
  }
);