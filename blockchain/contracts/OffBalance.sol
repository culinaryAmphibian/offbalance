// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

type JobID_t is uint256;

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

    // a provider's revealed answer; submitted tells a real answer apart from an unset slot
    struct Result_t {
        bytes32 answer; // keccak256(output)
        bool submitted;
    }

    struct Commitment_t {
        bool agreed;            // revealed the consensus answer
        bytes32 commitmentHash; // keccak256(abi.encode(keccak256(output), salt))
        bool delivered;         // server verified the delivery receipt
        uint256 stake;
    }

    struct Job {
        address payable creator;
        JobID_t id;
        uint256 price;
        uint256 k;      // number of providers that run the job
        uint256 quorum; // number of matching answers needed for consensus
        uint256 executionTime;
        Status status;
        string dockerImage;
        uint256 commitDeadline;
        uint256 revealDeadline;
        uint256 deliveryDeadline;
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
    // deadline is the job's execution time in seconds; providers use it as their run timeout
    event COMMIT_PHASE_START(JobID_t indexed jobId, uint256 deadline);
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
    mapping(JobID_t => Job) private jobs;
    mapping(address => Provider) private providers;
    mapping(address => uint256) public credits;

    // short windows sized for live demos; the server reads them through getDeadlines
    uint256 public constant REVEAL_WINDOW = 15;
    uint256 public constant DELIVERY_WINDOW = 30;
    uint256 public constant STAKE = 0.0001 ether;

    modifier onlyServer() {
        require(msg.sender == server, "Only server");
        _; // the function body runs here
    }

    constructor() {
        server = msg.sender;
    }

    // Stake a provider must post with its commitment.
    // TODO: make this an inverse function of the provider's reputation once reputation exists.
    function stakeFor(address) public pure returns (uint256) {
        return STAKE;
    }

    // Buyer escrows the full job price. The job id is reserved by the server's records beforehand.
    function submitJob(
        JobID_t jobId,
        uint256 price,
        uint256 k,
        uint256 quorum,
        uint256 executionTime,
        string calldata dockerImage
    ) external payable {
        Job storage job = jobs[jobId];
        require(job.creator == address(0), "Job id already used");
        require(price > 0, "Price must be positive");
        require(msg.value == price, "Send exact job price");
        require(quorum > 0 && quorum <= k, "Invalid consensus threshold");
        require(executionTime > 0, "Execution time must be positive");

        job.id = jobId;
        job.creator = payable(msg.sender);
        job.price = price;
        job.k = k;
        job.quorum = quorum;
        job.executionTime = executionTime;
        job.status = Status.JOB_SUBMITTED;
        job.dockerImage = dockerImage;

        emit JOB_SUBMITTED(jobId);
    }

    function cancelJob(JobID_t jobId) external {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        require(msg.sender == job.creator, "Only buyer");
        require(job.status == Status.JOB_SUBMITTED, "Job no longer pending");
        job.status = Status.CANCELED;
        credits[job.creator] += job.price;
        emit CANCELED(jobId);
    }

    // Provider commits to keccak256(abi.encode(keccak256(output), salt)) and stakes ETH.
    function submitCommitment(JobID_t jobId, bytes32 commitmentHash) external payable {
        Job storage job = jobs[jobId];
        require(job.status == Status.COMMIT, "Not in commit phase");
        require(block.timestamp <= job.commitDeadline, "Commit deadline passed");
        require(job.isAssigned[msg.sender], "Provider not assigned");
        require(commitmentHash != bytes32(0), "Empty commitment");
        require(msg.value == stakeFor(msg.sender), "Incorrect stake");

        Commitment_t storage c = providers[msg.sender].answers[jobId];
        require(c.commitmentHash == bytes32(0), "Already committed");
        c.commitmentHash = commitmentHash;
        c.stake = msg.value; // held by the contract until settlement
        emit COMMITTED(jobId, msg.sender);
    }

    // Reveal the output and salt; a reveal that doesn't match the commitment reverts.
    function submitReveal(JobID_t jobId, bytes calldata output, bytes32 salt) external {
        Job storage job = jobs[jobId];
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp <= job.revealDeadline, "Reveal deadline passed");
        require(job.isAssigned[msg.sender], "Provider not assigned");

        Commitment_t storage c = providers[msg.sender].answers[jobId];
        require(c.commitmentHash != bytes32(0), "No commitment");
        Result_t storage result = job.answers[msg.sender];
        require(!result.submitted, "Already revealed");

        bytes32 outputHash = keccak256(output);
        require(
            keccak256(abi.encode(outputHash, salt)) == c.commitmentHash,
            "Reveal does not match commitment"
        );

        result.answer = outputHash;
        result.submitted = true;
        emit REVEALED(jobId, msg.sender, outputHash);
    }

    // Trusted matcher assigns all k providers and starts the commit window.
    function assignProviders(JobID_t jobId, address[] calldata providerAddresses) external onlyServer {
        Job storage job = jobs[jobId];
        require(job.status == Status.JOB_SUBMITTED, "Job not awaiting assignment");
        require(providerAddresses.length == job.k, "Must assign exactly k providers");

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
        emit COMMIT_PHASE_START(jobId, job.executionTime);
    }

    // Called by the trusted server after it verifies an off-chain delivery receipt.
    function verifyReceipt(JobID_t jobId, address provider) external onlyServer {
        Job storage job = jobs[jobId];
        require(job.status == Status.DELIVERING, "Not in delivery phase");
        require(block.timestamp <= job.deliveryDeadline, "Delivery window ended");
        Commitment_t storage c = providers[provider].answers[jobId];
        require(c.agreed, "Provider did not agree with consensus");
        require(!c.delivered, "Already delivered");
        c.delivered = true;
    }

    function startRevealPhase(JobID_t jobId) public {
        Job storage job = jobs[jobId];
        require(job.status == Status.COMMIT, "Not in commit phase");
        require(block.timestamp > job.commitDeadline, "Commit phase not ended");
        // everyone who did not commit will not be able to reveal
        job.revealDeadline = block.timestamp + REVEAL_WINDOW;
        job.status = Status.REVEAL;
        emit REVEAL_PHASE_START(jobId);
    }

    // Without a quorum the job is treated as non-deterministic: the buyer gets no refund and
    // the providers who revealed are paid.
    function calculateConsensus(JobID_t jobId) private {
        Job storage job = jobs[jobId];
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp > job.revealDeadline, "Reveal phase not ended");
        emit CONSENSUS_VERIFICATION_START(jobId);

        bytes32 bestHash;
        uint256 bestCount = 0;

        // mappings can't live in memory, so tally distinct answers in parallel arrays
        uint256 n = job.assignedProviders.length;
        bytes32[] memory hashes = new bytes32[](n);
        uint256[] memory counts = new uint256[](n);
        uint256 unique = 0;
        for (uint256 i = 0; i < n; ++i) {
            Result_t storage res = job.answers[job.assignedProviders[i]];
            if (!res.submitted) continue;

            uint256 j = 0;
            while (j < unique && hashes[j] != res.answer) ++j;
            if (j == unique) hashes[unique++] = res.answer;
            uint256 count = ++counts[j];

            if (count > bestCount) {
                bestCount = count;
                bestHash = res.answer;
            }
        }

        if (bestCount >= job.quorum) {
            job.acceptedAnswer = Result_t(bestHash, true);
            job.consensusCount = bestCount;
            for (uint256 i; i < n; ++i) {
                address addr = job.assignedProviders[i];
                Result_t storage res = job.answers[addr];
                providers[addr].answers[jobId].agreed = res.submitted && res.answer == bestHash;
            }
            job.status = Status.CONSENSUS;
            emit CONSENSUS_REACHED(jobId, bestHash, bestCount);
        } else {
            job.status = Status.NO_QUORUM;
            emit NO_QUORUM(jobId);
            _settle(jobId, job, false);
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
        _settle(jobId, job, true);
        job.status = Status.PAID;
        emit DELIVERED(jobId);
    }

    // Pays out a finished job. With consensus, winners are the providers that agreed AND delivered;
    // without it (afterConsensus = false), every provider that revealed is paid. Everyone else
    // forfeits their stake, and the price plus the forfeited stakes are split among the winners.
    // If there are no winners the buyer is refunded the price and forfeited stakes stay in the contract.
    function _settle(JobID_t jobId, Job storage job, bool afterConsensus) private {
        uint256 n = job.assignedProviders.length;
        uint256 pot = job.price;
        uint256 winners = 0;
        for (uint256 i; i < n; ++i) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            if (_isWinner(job, c, addr, afterConsensus)) {
                ++winners;
            } else if (c.stake > 0) {
                uint256 slashed = c.stake;
                c.stake = 0;
                pot += slashed;
                emit SLASHED(jobId, addr, slashed);
            }
        }

        if (winners == 0) {
            credits[job.creator] += job.price;
            return;
        }

        uint256 share = pot / winners;
        uint256 remainder = pot - share * winners; // rounding dust goes to the first winner
        for (uint256 i; i < n; ++i) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            if (!_isWinner(job, c, addr, afterConsensus)) continue;
            uint256 amount = share + remainder;
            remainder = 0;
            credits[addr] += amount + c.stake;
            c.stake = 0;
            emit PAID(jobId, addr, amount);
        }
    }

    function _isWinner(Job storage job, Commitment_t storage c, address addr, bool afterConsensus)
        private view returns (bool) {
        return afterConsensus ? (c.agreed && c.delivered) : job.answers[addr].submitted;
    }

    // Pull-payment withdrawal avoids sending ETH during settlement loops.
    function withdraw() external {
        uint256 amount = credits[msg.sender];
        require(amount > 0, "No credit");
        credits[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
    }

    function getJobStatus(JobID_t jobId) external view returns (Status) {
        return jobs[jobId].status;
    }

    // The phase deadlines in chain time (0 until the phase starts). Whoever drives the job's
    // transitions (normally the server) schedules from these.
    function getDeadlines(JobID_t jobId)
        external view returns (Status status, uint256 commitDeadline, uint256 revealDeadline, uint256 deliveryDeadline) {
        Job storage job = jobs[jobId];
        return (job.status, job.commitDeadline, job.revealDeadline, job.deliveryDeadline);
    }

    function getAssignedProviders(JobID_t jobId) external view returns (address[] memory) {
        return jobs[jobId].assignedProviders;
    }

    function getProviderCommitment(JobID_t jobId, address provider)
        external view returns (bytes32 commitmentHash, bytes32 outputHash, bool revealed, bool agreed, bool delivered, uint256 stake) {
        Commitment_t storage c = providers[provider].answers[jobId];
        Result_t storage res = jobs[jobId].answers[provider];
        return (c.commitmentHash, res.answer, res.submitted, c.agreed, c.delivered, c.stake);
    }
}