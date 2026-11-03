// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

type JobID_t is uint256;
type Result_t is uint256;

function compareJobIds(JobID_t a, JobID_t b) pure returns (bool) {
    return JobID_t.unwrap(a) == JobID_t.unwrap(b);
}
using {compareJobIds as ==} for JobID_t global;

/// Job lifecycle:
///   submitJob ─▶ JOB_SUBMITTED
///   assignProviders (server) ─▶ PROVIDER_SELECTED   stake amounts are fixed here, per provider
///   submitStake (providers)                          deposit exactly the amount fixed at assignment
///   finalizeProviderSelection ─▶ COMMIT              unstaked providers are dropped
///                             └▶ NO_QUORUM           fewer than k staked: everyone refunded
///   submitCommitment / startRevealPhase ─▶ REVEAL
///   submitReveal / endRevealPhase ─▶ DELIVERING      ≥ k matching reveals
///                                └▶ NO_QUORUM        no consensus: everyone refunded
///   endDeliveryPhase ─▶ PAID                         winners split price + slashed stakes
///
/// Providers may act through a session key (see registerSessionKey). The session key signs
/// transactions; the provider's own address stays the identity that is assigned, credited, and
/// that alone may withdraw.
contract OffBalance {
    enum Status {
        JOB_SUBMITTED,
        // Providers have been assigned and the staking window is open.
        PROVIDER_SELECTED,
        // Transient: the staked provider set is final (never observed at rest).
        PROVIDERS_CONFIRMED,
        COMMIT,
        REVEAL,
        // Transient: consensus was reached (never observed at rest).
        CONSENSUS,
        DELIVERING,
        // Transient: delivery window closed, settlement in progress (never observed at rest).
        DELIVERED,
        PAID,
        CANCELED,
        NO_QUORUM
    }

    struct Commitment_t {
        bool winning;
        bool revealed;
        bytes32 commitmentHash; // keccak256(abi.encode(outputHash, salt))
        bytes32 outputHash;     // keccak256(output), populated at reveal
        uint256 requiredStake;  // fixed when the provider is assigned
        uint256 stake;          // currently deposited (0 once refunded, paid out or slashed)
    }

    struct Job {
        address payable creator;
        JobID_t id;
        uint256 price;
        uint256 k;              // matching reveals needed for consensus
        uint256 quorum;         // providers assigned
        uint256 executionTime;
        Status status;
        string dockerImgName;
        uint256 pendingDeadline;
        uint256 commitDeadline;
        uint256 revealDeadline;
        uint256 deliveryDeadline;
        uint256 stakedCount;
        address[] assignedProviders;
        mapping(address => bool) isAssigned;
        Result_t acceptedAnswer;
        uint256 consensusCount;
    }

    struct Provider {
        address payable addr;
        uint16 reputation;
        JobID_t[] jobsAssigned;
        mapping(JobID_t => Commitment_t) answers;
    }

    struct SessionKey {
        address owner;
        uint64 expiresAt;
    }

    event JOB_SUBMITTED(JobID_t indexed jobId);
    event PROVIDER_SELECTED(JobID_t indexed jobId, address indexed provider, uint256 stake);
    event COMMIT_STAKE_PHASE_START(JobID_t indexed jobId, uint256 deadline);
    event STAKED(JobID_t indexed jobId, address indexed provider, uint256 amount);
    // Emitted once the staking window closes and the eligible provider set is finalized.
    event PROVIDERS_SELECTED(JobID_t indexed jobId, uint256 providerCount);
    event COMMIT_PHASE_START(JobID_t indexed jobId, uint256 deadline);
    event REVEAL_PHASE_START(JobID_t indexed jobId, uint256 deadline);
    event CONSENSUS_VERIFICATION_START(JobID_t indexed jobId);
    event DELIVERY_PHASE_START(JobID_t indexed jobId, uint256 deadline);
    event DELIVERED(JobID_t indexed jobId);
    event PAID(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event SLASHED(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event STAKE_REFUNDED(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event CANCELED(JobID_t indexed jobId);
    event NO_QUORUM(JobID_t indexed jobId);
    event COMMITTED(JobID_t indexed jobId, address indexed provider);
    event REVEALED(JobID_t indexed jobId, address indexed provider, bytes32 outputHash);
    event CONSENSUS_REACHED(JobID_t indexed jobId, bytes32 outputHash, uint256 count);
    event SESSION_KEY_REGISTERED(address indexed owner, address indexed sessionKey, uint64 expiresAt);
    event SESSION_KEY_REVOKED(address indexed owner, address indexed sessionKey);

    address public immutable server;
    uint256 private nextJobId = 1;

    mapping(JobID_t => Job) private jobs;
    mapping(address => Provider) private providers;
    mapping(address => uint256) public credits;
    // Stake each provider currently has locked in unsettled jobs (returned or slashed at settlement).
    mapping(address => uint256) public lockedStake;

    // session key => owner + expiry
    mapping(address => SessionKey) public sessionKeys;
    // owner => its current session key (at most one at a time)
    mapping(address => address) public activeSessionKey;
    // owner => number of session keys registered so far; part of the signed message so a
    // revoked authorization can't be replayed.
    mapping(address => uint256) public sessionKeyNonce;

    // Providers have this long (in seconds) after assignment to deposit their required stake.
    uint256 public constant PENDING_WINDOW = 60 * 60 * 24;
    uint256 public constant REVEAL_WINDOW = 120;
    uint256 public constant DELIVERY_WINDOW = 300;

    // Base stake. A provider's stake is STAKE * (1 + MAX_EXTRA_STAKE * 2^(-reputation / REPUTATION_HALF_LIFE)),
    // so it starts at 6 * STAKE for a new provider and decays toward STAKE as reputation grows.
    uint256 public constant STAKE = 0.001 ether;
    uint256 public constant MAX_EXTRA_STAKE = 5;
    uint256 public constant REPUTATION_HALF_LIFE = 1000;

    bytes32 private constant SESSION_KEY_TYPEHASH = keccak256("OffBalance.registerSessionKey");
    // secp256k1n / 2, the upper bound for a non-malleable signature's s value
    uint256 private constant HALF_CURVE_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    modifier onlyServer() {
        require(msg.sender == server, "Only server");
        _;
    }

    constructor() {
        server = msg.sender;
    }

    // ───────────────────────────── staking curve ─────────────────────────────

    /// Stake `provider` would be asked for if assigned now. The amount is fixed at assignment;
    /// use getProviderCommitment(jobId, provider).requiredStake for a job already assigned.
    /// 2^-x is computed exactly at whole half-lives and linearly interpolated in between.
    function stakeFor(address provider) public view returns (uint256) {
        uint256 rep = providers[provider].reputation;
        uint256 extra = (STAKE * MAX_EXTRA_STAKE) >> (rep / REPUTATION_HALF_LIFE);
        extra -= (extra * (rep % REPUTATION_HALF_LIFE)) / (2 * REPUTATION_HALF_LIFE);
        return STAKE + extra;
    }

    function reputationOf(address provider) external view returns (uint16) {
        return providers[provider].reputation;
    }

    // ───────────────────────────── session keys ─────────────────────────────

    /// Digest the session key signs (EIP-191 personal_sign over these 32 bytes) to consent to
    /// acting for `owner`. In Python: Account.sign_message(encode_defunct(primitive=digest), key).
    function sessionKeyDigest(address owner, address sessionKey, uint64 expiresAt) public view returns (bytes32) {
        return keccak256(abi.encode(
            SESSION_KEY_TYPEHASH, block.chainid, address(this), owner, sessionKey, expiresAt, sessionKeyNonce[owner]
        ));
    }

    /// Called by the provider's main wallet to authorize `sessionKey` (the providerClient's hot key)
    /// to stake, commit and reveal on its behalf until `expiresAt`. `signature` is the session key's
    /// signature over sessionKeyDigest(msg.sender, sessionKey, expiresAt), proving the caller
    /// controls it; without that, anyone could hijack another provider's address as their key.
    /// Replaces any session key the caller already has. Payouts and refunds still go to the owner,
    /// and only the owner can withdraw. Any ETH sent is forwarded to the session key so it can pay
    /// gas and stakes; authorizing and funding then take one wallet confirmation.
    function registerSessionKey(address sessionKey, uint64 expiresAt, bytes calldata signature) external payable {
        require(sessionKey != address(0) && sessionKey != msg.sender, "Invalid session key");
        require(expiresAt > block.timestamp, "Expiry in the past");
        require(!_isActiveSessionKey(msg.sender), "Session key cannot own a session key");
        SessionKey storage existing = sessionKeys[sessionKey];
        require(
            existing.owner == address(0) || existing.owner == msg.sender || existing.expiresAt <= block.timestamp,
            "Session key bound to another owner"
        );
        bytes32 digest = sessionKeyDigest(msg.sender, sessionKey, expiresAt);
        require(_recover(_ethSignedMessageHash(digest), signature) == sessionKey, "Bad session key signature");

        _clearSessionKey(msg.sender);
        sessionKeyNonce[msg.sender]++;
        sessionKeys[sessionKey] = SessionKey(msg.sender, expiresAt);
        activeSessionKey[msg.sender] = sessionKey;
        emit SESSION_KEY_REGISTERED(msg.sender, sessionKey, expiresAt);

        if (msg.value > 0) {
            (bool ok, ) = payable(sessionKey).call{value: msg.value}("");
            require(ok, "Funding transfer failed");
        }
    }

    function revokeSessionKey() external {
        require(activeSessionKey[msg.sender] != address(0), "No session key");
        _clearSessionKey(msg.sender);
    }

    /// The provider a caller acts for: the owner if the caller is a live session key, else itself.
    function providerOf(address caller) public view returns (address) {
        SessionKey storage s = sessionKeys[caller];
        return (s.owner != address(0) && s.expiresAt > block.timestamp) ? s.owner : caller;
    }

    function _isActiveSessionKey(address a) private view returns (bool) {
        SessionKey storage s = sessionKeys[a];
        return s.owner != address(0) && s.expiresAt > block.timestamp;
    }

    function _clearSessionKey(address owner) private {
        address old = activeSessionKey[owner];
        if (old == address(0)) return;
        delete sessionKeys[old];
        delete activeSessionKey[owner];
        emit SESSION_KEY_REVOKED(owner, old);
    }

    function _ethSignedMessageHash(bytes32 digest) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
    }

    function _recover(bytes32 hash, bytes calldata sig) private pure returns (address) {
        require(sig.length == 65, "Bad signature length");
        bytes32 r = bytes32(sig[0:32]);
        bytes32 s = bytes32(sig[32:64]);
        uint8 v = uint8(sig[64]);
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "Bad signature v");
        require(uint256(s) <= HALF_CURVE_ORDER, "Bad signature s");
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "Bad signature");
        return signer;
    }

    // ───────────────────────────── buyer ─────────────────────────────

    // Buyer escrows the full job price. The contract assigns the job id.
    function submitJob(
        uint256 price,
        uint256 k,
        uint256 quorum,
        uint256 executionTime,
        string calldata dockerName
    ) external payable returns (JobID_t jobId) {
        require(price > 0, "Price must be positive");
        require(msg.value == price, "Send exact job price");
        require(k > 0 && quorum >= k, "Invalid consensus threshold");
        require(executionTime > 0, "Execution time must be positive");

        jobId = JobID_t.wrap(nextJobId++);
        Job storage job = jobs[jobId];
        job.id = jobId;
        job.creator = payable(msg.sender);
        job.price = price;
        job.k = k;
        job.quorum = quorum;
        job.executionTime = executionTime;
        job.status = Status.JOB_SUBMITTED;
        job.dockerImgName = dockerName;

        emit JOB_SUBMITTED(jobId);
    }

    // The buyer can cancel until the provider set is finalized. Escrow and any deposited stakes
    // go back as credits.
    function cancelJob(JobID_t jobId) external {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        require(msg.sender == job.creator, "Only buyer");
        require(job.status == Status.JOB_SUBMITTED || job.status == Status.PROVIDER_SELECTED, "Job no longer pending");
        job.status = Status.CANCELED;
        credits[job.creator] += job.price;
        _refundAllStakes(jobId);
        emit CANCELED(jobId);
    }

    // ───────────────────────────── providers ─────────────────────────────

    // The server proposes the provider set, fixes each provider's stake from its current
    // reputation, and opens the staking window.
    function assignProviders(JobID_t jobId, address[] calldata providerAddresses) external onlyServer {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        require(job.status == Status.JOB_SUBMITTED, "Job not awaiting assignment");
        require(providerAddresses.length == job.quorum, "Must assign exact quorum");

        for (uint256 i = 0; i < providerAddresses.length; ++i) {
            address addr = providerAddresses[i];
            require(addr != address(0), "Zero provider address");
            require(!job.isAssigned[addr], "Duplicate provider");
            require(!_isActiveSessionKey(addr), "Assign the owner, not its session key");
            job.isAssigned[addr] = true;
            job.assignedProviders.push(addr);
            Provider storage p = providers[addr];
            p.addr = payable(addr);
            p.jobsAssigned.push(jobId);
            uint256 required = stakeFor(addr);
            p.answers[jobId].requiredStake = required;
            emit PROVIDER_SELECTED(jobId, addr, required);
        }
        job.status = Status.PROVIDER_SELECTED;
        job.pendingDeadline = block.timestamp + PENDING_WINDOW;
        emit COMMIT_STAKE_PHASE_START(jobId, job.pendingDeadline);
    }

    // Deposit the stake fixed at assignment. May be sent by the provider or its session key;
    // either way the stake belongs to the provider.
    function submitStake(JobID_t jobId) external payable {
        Job storage job = jobs[jobId];
        address provider = providerOf(msg.sender);
        require(job.creator != address(0), "Unknown job");
        require(job.status == Status.PROVIDER_SELECTED, "Not in staking phase");
        require(block.timestamp <= job.pendingDeadline, "Staking window passed");
        require(job.isAssigned[provider], "Provider not assigned");
        Commitment_t storage c = providers[provider].answers[jobId];
        require(c.stake == 0, "Stake already submitted");
        require(msg.value == c.requiredStake, "Incorrect stake");

        c.stake = msg.value;
        lockedStake[provider] += msg.value;
        job.stakedCount++;
        emit STAKED(jobId, provider, msg.value);
    }

    // Close staking: drop providers that didn't stake, then start the commit phase, or refund
    // everyone if fewer than k remain. Anyone may call it once the window has passed, or as soon
    // as every assigned provider has staked.
    function finalizeProviderSelection(JobID_t jobId) external {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        require(job.status == Status.PROVIDER_SELECTED, "Not in staking phase");
        require(
            block.timestamp > job.pendingDeadline || job.stakedCount == job.assignedProviders.length,
            "Staking window not ended"
        );

        // Swap-and-pop the providers that didn't stake. Don't advance i after a removal: the
        // element swapped into slot i hasn't been checked yet.
        uint256 i = 0;
        while (i < job.assignedProviders.length) {
            address addr = job.assignedProviders[i];
            if (providers[addr].answers[jobId].stake == 0) {
                job.isAssigned[addr] = false;
                job.assignedProviders[i] = job.assignedProviders[job.assignedProviders.length - 1];
                job.assignedProviders.pop();
            } else {
                ++i;
            }
        }
        job.status = Status.PROVIDERS_CONFIRMED;
        emit PROVIDERS_SELECTED(jobId, job.assignedProviders.length);

        if (job.assignedProviders.length < job.k) {
            _noQuorum(jobId);
            return;
        }
        job.status = Status.COMMIT;
        job.commitDeadline = block.timestamp + job.executionTime;
        emit COMMIT_PHASE_START(jobId, job.commitDeadline);
    }

    // Commit to an output; the stake was already deposited in submitStake.
    function submitCommitment(JobID_t jobId, bytes32 commitmentHash) external {
        Job storage job = jobs[jobId];
        address provider = providerOf(msg.sender);
        require(job.status == Status.COMMIT, "Not in commit phase");
        require(block.timestamp <= job.commitDeadline, "Commit deadline passed");
        require(job.isAssigned[provider], "Provider not assigned");
        require(commitmentHash != bytes32(0), "Empty commitment");
        Commitment_t storage c = providers[provider].answers[jobId];
        require(c.commitmentHash == bytes32(0), "Already committed");
        c.commitmentHash = commitmentHash;
        emit COMMITTED(jobId, provider);
    }

    // Reveal the entire output and salt; invalid reveals revert and cannot count toward consensus.
    function submitReveal(JobID_t jobId, bytes calldata output, bytes32 salt) external {
        Job storage job = jobs[jobId];
        address provider = providerOf(msg.sender);
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp <= job.revealDeadline, "Reveal deadline passed");
        require(job.isAssigned[provider], "Provider not assigned");
        Commitment_t storage c = providers[provider].answers[jobId];
        require(c.commitmentHash != bytes32(0), "No commitment");
        require(!c.revealed, "Already revealed");
        bytes32 outputHash = keccak256(output);
        require(keccak256(abi.encode(outputHash, salt)) == c.commitmentHash, "Reveal does not match commitment");

        c.outputHash = outputHash;
        c.revealed = true;
        emit REVEALED(jobId, provider, outputHash);
    }

    // ───────────────────────────── phase transitions (anyone) ─────────────────────────────

    function startRevealPhase(JobID_t jobId) external {
        Job storage job = jobs[jobId];
        require(job.status == Status.COMMIT, "Not in commit phase");
        require(block.timestamp > job.commitDeadline, "Commit phase not ended");
        job.revealDeadline = block.timestamp + REVEAL_WINDOW;
        job.status = Status.REVEAL;
        emit REVEAL_PHASE_START(jobId, job.revealDeadline);
    }

    // Tally reveals. With k matching reveals the job moves to delivery; otherwise it ends in
    // NO_QUORUM and the buyer and every staked provider are refunded. This doesn't revert on
    // NO_QUORUM, so the refunds stick.
    function endRevealPhase(JobID_t jobId) external {
        Job storage job = jobs[jobId];
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp > job.revealDeadline, "Reveal phase not ended");
        emit CONSENSUS_VERIFICATION_START(jobId);

        (bytes32 bestHash, uint256 bestCount) = _tally(jobId);
        if (bestCount < job.k) {
            _noQuorum(jobId);
            return;
        }

        job.status = Status.CONSENSUS;
        job.acceptedAnswer = Result_t.wrap(uint256(bestHash));
        job.consensusCount = bestCount;
        for (uint256 i = 0; i < job.assignedProviders.length; ++i) {
            Commitment_t storage c = providers[job.assignedProviders[i]].answers[jobId];
            c.winning = c.revealed && c.outputHash == bestHash;
        }
        emit CONSENSUS_REACHED(jobId, bestHash, bestCount);

        job.status = Status.DELIVERING;
        job.deliveryDeadline = block.timestamp + DELIVERY_WINDOW;
        emit DELIVERY_PHASE_START(jobId, job.deliveryDeadline);
    }

    function endDeliveryPhase(JobID_t jobId) external {
        Job storage job = jobs[jobId];
        require(job.status == Status.DELIVERING, "Not in delivery phase");
        require(block.timestamp > job.deliveryDeadline, "Delivery window not ended");
        job.status = Status.DELIVERED;
        emit DELIVERED(jobId);
        _payWinnersAndSlashLosers(jobId);
    }

    // ───────────────────────────── settlement ─────────────────────────────

    // Most common revealed output hash and its count. Provider sets are small, so an O(n²)
    // in-memory count beats writing temporary counters to storage.
    function _tally(JobID_t jobId) private view returns (bytes32 bestHash, uint256 bestCount) {
        Job storage job = jobs[jobId];
        uint256 n = job.assignedProviders.length;
        bytes32[] memory hashes = new bytes32[](n);
        uint256 revealed = 0;
        for (uint256 i = 0; i < n; ++i) {
            Commitment_t storage c = providers[job.assignedProviders[i]].answers[jobId];
            if (c.revealed) hashes[revealed++] = c.outputHash;
        }
        for (uint256 i = 0; i < revealed; ++i) {
            uint256 count = 1;
            for (uint256 j = i + 1; j < revealed; ++j) {
                if (hashes[j] == hashes[i]) ++count;
            }
            if (count > bestCount) {
                bestCount = count;
                bestHash = hashes[i];
            }
        }
    }

    // Winners (revealed the consensus output) get their stake back plus an equal share of the
    // price and of every slashed stake; the first winner also gets the rounding dust. Every other
    // staked provider (wrong output, no commit, or no reveal) is slashed.
    function _payWinnersAndSlashLosers(JobID_t jobId) private {
        Job storage job = jobs[jobId];
        uint256 n = job.assignedProviders.length;

        uint256 winners = 0;
        uint256 slashedPool = 0;
        for (uint256 i = 0; i < n; ++i) {
            Commitment_t storage c = providers[job.assignedProviders[i]].answers[jobId];
            if (c.winning) ++winners;
            else slashedPool += c.stake;
        }
        require(winners >= job.k, "Consensus invariant failed");

        uint256 pool = job.price + slashedPool;
        uint256 share = pool / winners;
        uint256 dust = pool - share * winners;

        for (uint256 i = 0; i < n; ++i) {
            address addr = job.assignedProviders[i];
            Provider storage p = providers[addr];
            Commitment_t storage c = p.answers[jobId];
            uint256 staked = c.stake;
            if (staked == 0) continue;
            lockedStake[addr] -= staked;
            c.stake = 0;
            if (c.winning) {
                uint256 amount = share + dust;
                dust = 0;
                credits[addr] += amount + staked;
                if (p.reputation < type(uint16).max) p.reputation += 1;
                emit PAID(jobId, addr, amount);
            } else {
                if (p.reputation > 0) p.reputation -= 1;
                emit SLASHED(jobId, addr, staked);
            }
        }
        job.status = Status.PAID;
    }

    function _noQuorum(JobID_t jobId) private {
        Job storage job = jobs[jobId];
        job.status = Status.NO_QUORUM;
        credits[job.creator] += job.price;
        _refundAllStakes(jobId);
        emit NO_QUORUM(jobId);
    }

    function _refundAllStakes(JobID_t jobId) private {
        Job storage job = jobs[jobId];
        for (uint256 i = 0; i < job.assignedProviders.length; ++i) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            uint256 amount = c.stake;
            if (amount == 0) continue;
            lockedStake[addr] -= amount;
            c.stake = 0;
            credits[addr] += amount;
            emit STAKE_REFUNDED(jobId, addr, amount);
        }
    }

    // Pull-payment withdrawal avoids sending ETH during settlement loops. Session keys hold no
    // credits, so only a provider's own wallet can withdraw its earnings.
    function withdraw() external {
        uint256 amount = credits[msg.sender];
        require(amount > 0, "No credit");
        credits[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
    }

    // ───────────────────────────── views ─────────────────────────────

    function getJobStatus(JobID_t jobId) external view returns (Status) {
        return jobs[jobId].status;
    }

    // Phase deadlines in chain time (0 until the phase starts). The server's orchestrator
    // reads these to know when to call each phase transition.
    function getDeadlines(JobID_t jobId)
        external
        view
        returns (
            Status status,
            uint256 pendingDeadline,
            uint256 commitDeadline,
            uint256 revealDeadline,
            uint256 deliveryDeadline
        )
    {
        Job storage job = jobs[jobId];
        return (job.status, job.pendingDeadline, job.commitDeadline, job.revealDeadline, job.deliveryDeadline);
    }

    function getAssignedProviders(JobID_t jobId) external view returns (address[] memory) {
        return jobs[jobId].assignedProviders;
    }

    function getProviderCommitment(JobID_t jobId, address provider)
        external
        view
        returns (
            bytes32 commitmentHash,
            bytes32 outputHash,
            bool revealed,
            bool winning,
            uint256 requiredStake,
            uint256 stake
        )
    {
        Commitment_t storage c = providers[provider].answers[jobId];
        return (c.commitmentHash, c.outputHash, c.revealed, c.winning, c.requiredStake, c.stake);
    }
}
