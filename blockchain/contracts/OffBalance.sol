// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

type JobID_t is uint256;
type Result_t is uint256;

function compareJobIds(JobID_t a, JobID_t b) pure returns (bool) {
    return JobID_t.unwrap(a) == JobID_t.unwrap(b);
}
using {compareJobIds as ==} for JobID_t global;

contract OffBalance {
    enum Status {
        JOB_SUBMITTED,
        PROVIDER_SELECTED,
        COMMIT,
        REVEAL,
        CONSENSUS,
        DELIVERING,
        DELIVERED,
        PAID,
        CANCELED,
        NO_QUORUM
    }

    struct Commitment_t {
        bool winning;
        bytes32 commitmentHash; // keccak256(abi.encode(outputHash, salt))
        bytes32 outputHash;     // keccak256(output), populated at reveal
        bool revealed;
        bool delivered;
        uint256 stake;
    }

    struct Job {
        address payable creator;
        JobID_t id;
        uint256 price;
        uint256 k;
        uint256 quorum;
        uint256 executionTime;
        Status status;
        string dockerImgName;
        uint256 commitDeadline;
        uint256 revealDeadline;
        uint256 deliveryDeadline; // can be inferred
        address[] assignedProviders;
        mapping(address => Result_t) answers;
        mapping(address => bool) isAssigned;
        // each assigned provider's stake, fixed at assignment so later settlements can't change it
        mapping(address => uint256) requiredStake;
        Result_t acceptedAnswer;
        uint256 consensusCount;
    }

    struct Provider {
        address addr;
        JobID_t[] jobsAssigned;
        mapping(JobID_t => Commitment_t) answers;
    }

    // Value-weighted track record, in wei of job value. `earned` grows by each payout a provider
    // gets for agreeing with the consensus; a failure adds its weight to `strikes` and takes the
    // same amount off `earned`.
    struct Reputation {
        uint256 earned;
        uint256 strikes;
    }

    event JOB_SUBMITTED(JobID_t indexed jobId);
    event PROVIDER_SELECTED(JobID_t indexed jobId, address indexed provider);
    // deadline is the job's execution time in seconds; providers use it as their run timeout
    event COMMIT_PHASE_START(JobID_t indexed jobId, uint256 deadline);
    event REVEAL_PHASE_START(JobID_t indexed jobId);
    event CONSENSUS_VERIFICATION_START(JobID_t indexed jobId);
    event DELIVERY_PHASE_START(JobID_t indexed jobId);
    event DELIVERED(JobID_t indexed jobId);
    event PAID(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event SLASHED(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event STAKE_REFUNDED(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event CANCELED(JobID_t indexed jobId);
    event NO_QUORUM(JobID_t indexed jobId);
    event COMMITTED(JobID_t indexed jobId, address indexed provider);
    event REVEALED(JobID_t indexed jobId, address indexed provider, bytes32 outputHash);
    event CONSENSUS_REACHED(JobID_t indexed jobId, bytes32 outputHash, uint256 count);
    // a provider's reputation after a settled job; trustBps is reputationOf's score
    event REPUTATION_UPDATED(JobID_t indexed jobId, address indexed provider, uint256 earned, uint256 strikes, uint256 trustBps);

    address public immutable server;
    uint256 private nextJobId = 1;
    mapping(JobID_t => Job) private jobs;
    mapping(address => Provider) private providers;
    mapping(address => uint256) public credits;
    // Stake each provider currently has locked in unsettled jobs (returned or slashed at settlement).
    mapping(address => uint256) public lockedStake;
	mapping(bytes32 => uint256) private temp_hashes;

    uint256 public constant REVEAL_WINDOW = 15;
    uint256 public constant DELIVERY_WINDOW = 30;

    modifier onlyServer() {
        require(msg.sender == server, "Only server");
        _; // what is this?
    }

    mapping(address => Reputation) public reputation;

    uint256 private constant BPS = 10_000;
    // The base stake is 10% of a provider's fair share of the price (price / quorum).
    uint256 public constant BASE_STAKE_BPS = 1_000;
    // Reputation scales the base stake between 0.5x (trusted) and 3x (untrusted).
    uint256 public constant MIN_MULTIPLIER_BPS = 5_000;
    uint256 public constant MAX_MULTIPLIER_BPS = 30_000;
    // Prior, in wei of job value: a new provider's trust is 50%, and a single job of about
    // this price moves it noticeably but not all the way.
    uint256 public constant REPUTATION_PRIOR = 0.01 ether;
    // Strike weights, as a multiple (in bps) of the provider's share of the price.
    uint256 public constant WRONG_ANSWER_BPS = 30_000; // revealed an answer the consensus rejected
    uint256 public constant NO_REVEAL_BPS = 20_000;    // committed but never revealed
    uint256 public constant NO_COMMIT_BPS = 10_000;    // assigned but never committed

    // Trust in bps: (earned + prior) / (earned + strikes + 2 * prior). New providers are at 5000.
    function trustBps(address provider) public view returns (uint256) {
        Reputation storage r = reputation[provider];
        return (r.earned + REPUTATION_PRIOR) * BPS / (r.earned + r.strikes + 2 * REPUTATION_PRIOR);
    }

    // Stake multiplier for a job of `price`, in bps. Below 50% trust it rises to 3x. Above it, it
    // falls towards 0.5x, but the discount only counts in proportion to how much value the provider
    // has already delivered relative to this job's price, so trust farmed on cheap jobs doesn't
    // discount an expensive one.
    function stakeMultiplierBps(address provider, uint256 price) public view returns (uint256) {
        uint256 trust = trustBps(provider);
        uint256 half = BPS / 2;
        if (trust < half) return BPS + (MAX_MULTIPLIER_BPS - BPS) * (half - trust) / half;
        uint256 discount = (BPS - MIN_MULTIPLIER_BPS) * (trust - half) / half;
        uint256 earned = reputation[provider].earned;
        if (earned < price) discount = discount * earned / price;
        return BPS - discount;
    }

    // What `provider` would stake on a job of `price` split among `quorum` providers. At least 1 wei.
    function stakeQuote(address provider, uint256 price, uint256 quorum) public view returns (uint256) {
        require(quorum > 0, "Invalid quorum");
        uint256 stake = price * BASE_STAKE_BPS * stakeMultiplierBps(provider, price) / (BPS * BPS * quorum);
        return stake > 0 ? stake : 1;
    }

    // The exact stake `provider` must send with its commitment to `jobId`: fixed when the job was
    // assigned, or, before that, what it would be now.
    function stakeFor(JobID_t jobId, address provider) public view returns (uint256) {
        Job storage job = jobs[jobId];
        if (job.isAssigned[provider]) return job.requiredStake[provider];
        require(job.creator != address(0), "Unknown job");
        return stakeQuote(provider, job.price, job.quorum);
    }

    // Everything the provider page shows: the raw totals, trust, and the best-case multiplier
    // (for jobs priced at or below `earned`, where the full discount applies).
    function reputationOf(address provider)
        external view returns (uint256 earned, uint256 strikes, uint256 trust, uint256 multiplierBps) {
        Reputation storage r = reputation[provider];
        return (r.earned, r.strikes, trustBps(provider), stakeMultiplierBps(provider, r.earned));
    }

    constructor() {
        server = msg.sender;
    }

    // Buyer escrows the full job price. The contract assigns the job id.
    function submitJob(
        uint256 price,
        uint256 k,
        uint256 quorum,
        uint256 executionTime,
        string calldata dockerName
    ) external payable returns (bool) {
        require(price > 0, "Price must be positive");
        require(msg.value == price, "Send exact job price");
        require(k > 0 && quorum >= k, "Invalid consensus threshold");
        require(executionTime > 0, "Execution time must be positive");

        JobID_t jobId = JobID_t.wrap(nextJobId++);
        Job storage job = jobs[jobId];
        job.id = jobId;
        job.creator = payable(msg.sender);
        job.price = price;
        job.k = k;
        job.quorum = quorum;
        job.executionTime = executionTime;
        job.status = Status.JOB_SUBMITTED;
        job.dockerImgName = dockerName;
		// set job.commitDeadline after it has been delivered 

        emit JOB_SUBMITTED(jobId);
        return true;
    }

    function cancelJob(JobID_t jobId) external returns (bool) {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job"); // ?
        require(msg.sender == job.creator, "Only buyer");
        require(job.status == Status.JOB_SUBMITTED, "Job no longer pending");
        job.status = Status.CANCELED;
        credits[job.creator] += job.price;
        emit CANCELED(jobId);
        return true;
    }

    // Provider commits to keccak256(abi.encode(keccak256(output), salt)) and stakes ETH.
    function submitCommitment(JobID_t jobId, bytes32 commitmentHash) external payable {
        Job storage job = jobs[jobId];
        require(job.status == Status.COMMIT, "Not in commit phase");
        require(block.timestamp <= job.commitDeadline, "Commit deadline passed");
        require(job.isAssigned[msg.sender], "Provider not assigned");
        require(commitmentHash != bytes32(0), "Empty commitment");
        require(msg.value == job.requiredStake[msg.sender], "Incorrect stake");

        Commitment_t storage c = providers[msg.sender].answers[jobId];
        require(c.commitmentHash == bytes32(0), "Already committed"); // ? will this crash if not true?
        c.commitmentHash = commitmentHash;
        c.stake = msg.value; // held by the contract until settlement
        lockedStake[msg.sender] += msg.value;
        emit COMMITTED(jobId, msg.sender);
    }

    // Reveal the entire output and salt; invalid reveals revert and cannot count toward consensus.
    function submitReveal(JobID_t jobId, bytes calldata output, bytes32 salt) external {
        Job storage job = jobs[jobId]; // assumes job exists
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp <= job.revealDeadline, "Reveal deadline passed");
        require(job.isAssigned[msg.sender], "Provider not assigned");

        Commitment_t storage c = providers[msg.sender].answers[jobId];
        require(c.commitmentHash != bytes32(0), "No commitment");
        require(!c.revealed, "Already revealed");

        bytes32 outputHash = keccak256(output);
        require(
            keccak256(abi.encode(outputHash, salt)) == c.commitmentHash,
            "Reveal does not match commitment"
        );

        c.outputHash = outputHash;
        c.revealed = true;
        job.answers[msg.sender] = Result_t.wrap(uint256(outputHash));
        emit REVEALED(jobId, msg.sender, outputHash);
    }

    // Trusted matcher assigns the complete quorum and starts the commit window.
    function assignProviders(JobID_t jobId, address[] calldata providerAddresses) external onlyServer {
        Job storage job = jobs[jobId];
        require(job.status == Status.JOB_SUBMITTED, "Job not awaiting assignment");
        require(providerAddresses.length == job.quorum, "Must assign exact quorum");

        for (uint256 i = 0; i < providerAddresses.length; ++i) {
            address addr = providerAddresses[i];
            require(addr != address(0), "Zero provider address");
            require(!job.isAssigned[addr], "Duplicate provider");
            job.isAssigned[addr] = true;
            job.requiredStake[addr] = stakeQuote(addr, job.price, job.quorum);
            job.assignedProviders.push(addr);
            providers[addr].addr = addr;
            providers[addr].jobsAssigned.push(jobId);
            emit PROVIDER_SELECTED(jobId, addr);
        }

        job.status = Status.COMMIT;
        job.commitDeadline = block.timestamp + job.executionTime;
        emit COMMIT_PHASE_START(jobId, job.executionTime);
    }

    // Called by the trusted server after it verifies an off-chain delivery receipt.
	// I think this can, and should, be done off-chain
	/*
    function verifyReceipt(JobID_t jobId, address provider) external onlyServer {
        Job storage job = jobs[jobId];
        require(job.status == Status.DELIVERING, "Not in delivery phase");
        require(block.timestamp <= job.deliveryDeadline, "Delivery window ended");
        Commitment_t storage c = providers[provider].answers[jobId];
        require(c.winning, "Provider is not a winner");
        require(!c.delivered, "Already delivered");
        c.delivered = true;
    }
	*/

    function startRevealPhase(JobID_t jobId) public {
        Job storage job = jobs[jobId];
        require(job.status == Status.COMMIT, "Not in commit phase");
        require(block.timestamp > job.commitDeadline, "Commit phase not ended");
		// everyone who did not commit will not be able to reveal
        job.revealDeadline = block.timestamp + REVEAL_WINDOW;
        job.status = Status.REVEAL;
        emit REVEAL_PHASE_START(jobId);
    }

	// When consensus fails nobody is at fault for certain: the buyer gets the price back and
	// every provider that committed gets its stake back. Providers who never committed staked nothing.
	// todo: validate hash(revealed hash + nonce) == committed hash
    function calculateConsensus(JobID_t jobId) private {
        Job storage job = jobs[jobId];
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp > job.revealDeadline, "Reveal phase not ended");
        emit CONSENSUS_VERIFICATION_START(jobId);

		for (uint256 i = 0; i < job.assignedProviders.length; i++) {
			address candidate = job.assignedProviders[i];
            bytes32 candidateCommit = providers[candidate].answers[jobId].outputHash;
			temp_hashes[candidateCommit] = 0;
		}
        bytes32 bestHash;
        uint256 bestCount = 0;
        for (uint256 i = 0; i < job.assignedProviders.length; ++i) {
            address candidate = job.assignedProviders[i];
            Commitment_t storage candidateCommit = providers[candidate].answers[jobId];
            if (!candidateCommit.revealed) continue;

			uint256 count = ++temp_hashes[candidateCommit.outputHash];
            if (count > bestCount) {
                bestCount = count;
                bestHash = candidateCommit.outputHash;
            }
        }

        if (bestCount >= job.k) {
            job.acceptedAnswer = Result_t.wrap(uint256(bestHash));
            job.consensusCount = bestCount;
            for (uint256 i; i < job.assignedProviders.length; ++i) {
                address addr = job.assignedProviders[i];
                Commitment_t storage c = providers[addr].answers[jobId];
                c.winning = c.revealed && c.outputHash == bestHash;
            }
            job.status = Status.CONSENSUS;
            emit CONSENSUS_REACHED(jobId, bestHash, bestCount);
        } else {
            job.status = Status.NO_QUORUM;
            emit NO_QUORUM(jobId);
            // Buyer gets the escrowed price back; every submitted stake is returned.
            credits[job.creator] += job.price;
            _refundAllStakes(jobId, job);
            // Revealing providers can't be told apart, so only missing commits and reveals count against anyone.
            for (uint256 i; i < job.assignedProviders.length; ++i) {
                address addr = job.assignedProviders[i];
                Commitment_t storage c = providers[addr].answers[jobId];
                if (!c.revealed) _recordStrike(job, addr, c.commitmentHash == bytes32(0) ? NO_COMMIT_BPS : NO_REVEAL_BPS);
            }
        }
    }

    function _recordEarned(Job storage job, address provider, uint256 amount) private {
        reputation[provider].earned += amount;
        _emitReputation(job, provider);
    }

    // weight in bps of the provider's share of the job's price
    function _recordStrike(Job storage job, address provider, uint256 weightBps) private {
        Reputation storage r = reputation[provider];
        uint256 strike = job.price * weightBps / (BPS * job.quorum);
        r.strikes += strike;
        r.earned -= strike < r.earned ? strike : r.earned;
        _emitReputation(job, provider);
    }

    function _emitReputation(Job storage job, address provider) private {
        Reputation storage r = reputation[provider];
        emit REPUTATION_UPDATED(job.id, provider, r.earned, r.strikes, trustBps(provider));
    }

    function endRevealPhase(JobID_t jobId) public {
        Job storage job = jobs[jobId];
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp > job.revealDeadline, "Reveal phase not ended");
        calculateConsensus(jobId);
        if (job.status == Status.NO_QUORUM) return;

        job.deliveryDeadline = block.timestamp + DELIVERY_WINDOW;
        job.status = Status.DELIVERING;
        emit DELIVERY_PHASE_START(jobId);
    }

    function endDeliveryPhase(JobID_t jobId) public {
        Job storage job = jobs[jobId];
        require(job.status == Status.DELIVERING, "Not in delivery phase");
        require(block.timestamp > job.deliveryDeadline, "Delivery window not ended");
        job.status = Status.DELIVERED;
        payWinnersAndSlashLosers(jobId);
        emit DELIVERED(jobId);
    }

    function payWinnersAndSlashLosers(JobID_t jobId) private {
        Job storage job = jobs[jobId];
        require(job.status == Status.DELIVERED, "Job not delivered/settleable");
        uint256 winners;
        for (uint256 i; i < job.assignedProviders.length; ++i) {
            if (providers[job.assignedProviders[i]].answers[jobId].winning) ++winners;
        }
        require(winners >= job.k, "Consensus invariant failed");

        uint256 share = job.price / winners;

        for (uint256 i = 0; i < job.assignedProviders.length; ++i) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            if (c.winning) {
                uint256 amount = share;
                credits[addr] += amount + c.stake;
                emit PAID(jobId, addr, amount);
                lockedStake[addr] -= c.stake;
                c.stake = 0;
                _recordEarned(job, addr, amount);
                continue;
            }
            if (c.stake > 0) {
                uint256 amountSlashed = c.stake;
                // Slashed stake is retained by the contract; it is not awarded to anyone.
                emit SLASHED(jobId, addr, amountSlashed);
                lockedStake[addr] -= c.stake;
                c.stake = 0;
            }
            _recordStrike(job, addr,
                c.revealed ? WRONG_ANSWER_BPS : c.commitmentHash != bytes32(0) ? NO_REVEAL_BPS : NO_COMMIT_BPS);
        }
        job.status = Status.PAID;
    }

    // Return each provider's stake as withdrawable credit.
    function _refundAllStakes(JobID_t jobId, Job storage job) private {
        for (uint256 i; i < job.assignedProviders.length; ++i) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            if (c.stake > 0) {
                uint256 amount = c.stake;
                lockedStake[addr] -= c.stake;
                c.stake = 0;
                credits[addr] += amount;
                emit STAKE_REFUNDED(jobId, addr, amount);
            }
        }
    }

    // Pull-payment withdrawal avoids sending ETH during settlement loops.
    function withdraw() external {
        uint256 amount = credits[msg.sender]; // ! we should not be doing this
        require(amount > 0, "No credit");
        credits[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
    }

    function getJobStatus(JobID_t jobId) external view returns (Status) {
        return jobs[jobId].status;
    }

    // Phase deadlines in chain time (0 until the phase starts). The server's orchestrator
    // reads these to know when to call startRevealPhase / endRevealPhase / endDeliveryPhase.
    function getDeadlines(JobID_t jobId)
        external view returns (Status status, uint256 commitDeadline, uint256 revealDeadline, uint256 deliveryDeadline) {
        Job storage job = jobs[jobId];
        return (job.status, job.commitDeadline, job.revealDeadline, job.deliveryDeadline);
    }

    function getAssignedProviders(JobID_t jobId) external view returns (address[] memory) {
        return jobs[jobId].assignedProviders;
    }

    function getProviderCommitment(JobID_t jobId, address provider)
        external view returns (bytes32 commitmentHash, bytes32 outputHash, bool revealed, bool winning, bool delivered, uint256 stake) {
        Commitment_t storage c = providers[provider].answers[jobId];
        return (c.commitmentHash, c.outputHash, c.revealed, c.winning, c.delivered, c.stake); // does it need to be destructured?
    }
}
