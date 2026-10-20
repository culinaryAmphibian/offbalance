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
        uint256 stakeAmount;
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
        Result_t acceptedAnswer;
        uint256 consensusCount;
    }

    struct Provider {
        address addr;
        JobID_t[] jobsAssigned;
        mapping(JobID_t => Commitment_t) answers;
    }

    event JOB_SUBMITTED(JobID_t indexed jobId);
    event PROVIDER_SELECTED(JobID_t indexed jobId, address indexed provider);
    event COMMIT_PHASE_START(JobID_t indexed jobId);
    event REVEAL_PHASE_START(JobID_t indexed jobId);
    event CONSENSUS_VERIFICATION_START(JobID_t indexed jobId);
    event DELIVERY_PHASE_START(JobID_t indexed jobId);
    event DELIVERED(JobID_t indexed jobId);
    event PAID(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event SLASHED(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event CANCELED(JobID_t indexed jobId);
    event NO_QUORUM(JobID_t indexed jobId);
    event COMMITTED(JobID_t indexed jobId, address indexed provider);
    event REVEALED(JobID_t indexed jobId, address indexed provider, bytes32 outputHash);
    event CONSENSUS_REACHED(JobID_t indexed jobId, bytes32 outputHash, uint256 count);

    address public immutable server;
    uint256 private nextJobId = 1;
    mapping(JobID_t => Job) private jobs;
    mapping(address => Provider) private providers;
    mapping(address => uint256) public credits;

    uint256 public constant REVEAL_WINDOW = 120;
    uint256 public constant DELIVERY_WINDOW = 300;

    modifier onlyServer() {
        require(msg.sender == server, "Only server");
        _; // what is this?
    }

    constructor() {
        server = msg.sender;
    }

    // Buyer escrows the full job price and specifies the stake required from each provider.
    function submitJob(
        uint256 price,
        uint256 stakeAmount,
        uint256 k,
        uint256 quorum,
        uint256 executionTime,
        string calldata dockerName
    ) external payable returns (bool) {
        require(price > 0, "Price must be positive");
        require(msg.value == price, "Send exact job price");
        require(stakeAmount > 0, "Stake must be positive");
        require(k > 0 && quorum >= k, "Invalid consensus threshold");
        require(executionTime > 0, "Execution time must be positive");

        JobID_t jobId = JobID_t.wrap(nextJobId++);
        Job storage job = jobs[jobId];
        job.id = jobId;
        job.creator = payable(msg.sender);
        job.price = price;
        job.stakeAmount = stakeAmount;
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
        require(msg.value == job.stakeAmount, "Incorrect stake"); // will later be scaled by provider reputation

        Commitment_t storage c = providers[msg.sender].answers[jobId];
        require(c.commitmentHash == bytes32(0), "Already committed"); // ? will this crash if not true?
        c.commitmentHash = commitmentHash;
        c.stake = msg.value; // ? is the money actually in escrow now?
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
            job.assignedProviders.push(addr);
            providers[addr].addr = addr;
            providers[addr].jobsAssigned.push(jobId);
            emit PROVIDER_SELECTED(jobId, addr);
        }

        job.status = Status.COMMIT;
        job.commitDeadline = block.timestamp + job.executionTime;
        emit COMMIT_PHASE_START(jobId);
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

	// The buyer receives a refund when consensus fails, while providers forfeit any stakes they actually deposited.
	// Providers who never committed have no stake to forfeit.
	// todo: validate hash(revealed hash + nonce) == committed hash
    function calculateConsensus(JobID_t jobId) private {
        Job storage job = jobs[jobId];
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp > job.revealDeadline, "Reveal phase not ended");
        emit CONSENSUS_VERIFICATION_START(jobId);

        bytes32 bestHash;
        uint256 bestCount = 0;
		mapping(bytes32 => uint256) memory hashes;
        for (uint256 i = 0; i < job.assignedProviders.length; ++i) {
            address candidate = job.assignedProviders[i];
            Commitment_t storage candidateCommit = providers[candidate].answers[jobId];
            if (!candidateCommit.revealed) continue;
			
			if (!hashes[candidateCommit.outputHash]) {
				hashes[candidateCommit.outputHash] = 0;
			}
			uint256 count = ++hashes[candidateCommit.outputHash];

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
            // Buyer gets the escrowed price back; all submitted stakes are forfeited.
            credits[job.creator] += job.price;
            _slashAllStakes(jobId, job);
        }
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
                c.stake = 0;
            } else if (c.stake > 0) {
                uint256 amountSlashed = c.stake;
                // Slashed stake is retained by the contract; it is not awarded to anyone.
                emit SLASHED(jobId, addr, amountSlashed);
                c.stake = 0;
            }
        }
        job.status = Status.PAID;
    }

    function _slashAllStakes(JobID_t jobId, Job storage job) private {
        for (uint256 i; i < job.assignedProviders.length; ++i) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            if (c.stake > 0) {
                uint256 amount = c.stake;
                c.stake = 0;
                emit SLASHED(jobId, addr, amount);
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

    function getAssignedProviders(JobID_t jobId) external view returns (address[] memory) {
        return jobs[jobId].assignedProviders;
    }

    function getProviderCommitment(JobID_t jobId, address provider)
        external view returns (bytes32 commitmentHash, bytes32 outputHash, bool revealed, bool winning, bool delivered, uint256 stake) {
        Commitment_t storage c = providers[provider].answers[jobId];
        return (c.commitmentHash, c.outputHash, c.revealed, c.winning, c.delivered, c.stake); // does it need to be destructured?
    }
}
