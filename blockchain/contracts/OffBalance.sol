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
        uint256 hourlyRate;
        uint256 bookedCharge;
    }

    struct Job {
        address payable creator;
        JobID_t id;
        uint256 maxHourlyRate; // wei per hour, per provider
        uint256 escrow; // full booked execution window at the cap for all k providers
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
    event STAKE_RETURNED(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event SLASH_REWARD(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event SLASHED(JobID_t indexed jobId, address indexed provider, uint256 amount);
    event JOB_SETTLED(
        JobID_t indexed jobId, address indexed buyer, uint256 escrow,
        uint256 workPaid, uint256 refund, uint256 slashedStake
    );
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

    // Exact ceil(hourlyRate * executionTime / 3600), including products wider than uint256.
    // Decomposing both factors prevents intermediate overflow when the final quote fits.
    function quoteProvider(uint256 hourlyRate, uint256 executionTime) public pure returns (uint256) {
        require(hourlyRate > 0, "Hourly rate must be positive");
        require(executionTime > 0, "Execution time must be positive");
        uint256 remainder = hourlyRate % 3600;
        uint256 fractional = remainder * (executionTime % 3600);
        return (hourlyRate / 3600) * executionTime
            + remainder * (executionTime / 3600)
            + fractional / 3600 + (fractional % 3600 == 0 ? 0 : 1);
    }

    function quoteEscrow(uint256 maxHourlyRate, uint256 executionTime, uint256 k) public pure returns (uint256) {
        require(k > 0, "Provider count must be positive");
        return quoteProvider(maxHourlyRate, executionTime) * k;
    }

    // Buyer books the entire execution window; faster completion never changes the charge.
    // The job id is reserved by the server's records beforehand.
    function submitJob(
        JobID_t jobId,
        uint256 maxHourlyRate,
        uint256 k,
        uint256 quorum,
        uint256 executionTime,
        string calldata dockerImage
    ) external payable {
        Job storage job = jobs[jobId];
        require(job.creator == address(0), "Job id already used");
        require(quorum > 0 && quorum <= k, "Invalid consensus threshold");
        uint256 escrow = quoteEscrow(maxHourlyRate, executionTime, k);
        require(msg.value == escrow, "Send exact job escrow");

        job.id = jobId;
        job.creator = payable(msg.sender);
        job.maxHourlyRate = maxHourlyRate;
        job.escrow = escrow;
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
        credits[job.creator] += job.escrow;
        emit CANCELED(jobId);
        emit JOB_SETTLED(jobId, job.creator, job.escrow, 0, job.escrow, 0);
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
    function assignProviders(
        JobID_t jobId, address[] calldata providerAddresses, uint256[] calldata hourlyRates
    ) external onlyServer {
        Job storage job = jobs[jobId];
        require(job.status == Status.JOB_SUBMITTED, "Job not awaiting assignment");
        require(providerAddresses.length == job.k, "Must assign exactly k providers");
        require(hourlyRates.length == providerAddresses.length, "Provider rates length mismatch");

        for (uint256 i = 0; i < providerAddresses.length; ++i) {
            address addr = providerAddresses[i];
            require(addr != address(0), "Zero provider address");
            require(!job.isAssigned[addr], "Duplicate provider");
            require(hourlyRates[i] > 0 && hourlyRates[i] <= job.maxHourlyRate, "Provider rate outside cap");
            Commitment_t storage pricing = providers[addr].answers[jobId];
            pricing.hourlyRate = hourlyRates[i];
            pricing.bookedCharge = quoteProvider(hourlyRates[i], job.executionTime);
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

    // Without a quorum, refund all buyer escrow and return providers' own stakes.
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

    // Work charges, returned deposits and slashing rewards remain distinct.
    function _settle(JobID_t jobId, Job storage job, bool afterConsensus) private {
        if (!afterConsensus) {
            for (uint256 i; i < job.assignedProviders.length; ++i) {
                address addr = job.assignedProviders[i];
                Commitment_t storage c = providers[addr].answers[jobId];
                uint256 stake = c.stake;
                if (stake == 0) continue;
                c.stake = 0;
                credits[addr] += stake;
                emit STAKE_RETURNED(jobId, addr, stake);
            }
            credits[job.creator] += job.escrow;
            emit JOB_SETTLED(jobId, job.creator, job.escrow, 0, job.escrow, 0);
            return;
        }
        uint256 workPaid;
        uint256 slashedStake;
        uint256 winners;
        for (uint256 i; i < job.assignedProviders.length; ++i) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            if (_isWinner(c)) {
                workPaid += c.bookedCharge;
                ++winners;
            } else if (c.stake > 0) {
                uint256 stake = c.stake;
                slashedStake += stake;
                c.stake = 0;
                emit SLASHED(jobId, addr, stake);
            }
        }
        // Preserve the existing no-winner policy: slashed stakes stay in the contract.
        if (winners > 0) {
            uint256 bonus = slashedStake / winners;
            uint256 remainder = slashedStake % winners;
            for (uint256 i; i < job.assignedProviders.length; ++i) {
                address addr = job.assignedProviders[i];
                Commitment_t storage c = providers[addr].answers[jobId];
                if (!_isWinner(c)) continue;
                uint256 reward = bonus + remainder;
                remainder = 0;
                credits[addr] += c.bookedCharge + c.stake + reward;
                emit PAID(jobId, addr, c.bookedCharge);
                emit STAKE_RETURNED(jobId, addr, c.stake);
                if (reward > 0) emit SLASH_REWARD(jobId, addr, reward);
                c.stake = 0;
            }
        }
        uint256 refund = job.escrow - workPaid;
        credits[job.creator] += refund;
        emit JOB_SETTLED(jobId, job.creator, job.escrow, workPaid, refund, slashedStake);
    }

    function _isWinner(Commitment_t storage c)
        private view returns (bool) {
        return c.agreed && c.delivered;
    }

    // Pull-payment withdrawal avoids sending ETH during settlement loops.
    function withdraw() external {
        uint256 amount = credits[msg.sender];
        require(amount > 0, "No credit");
        credits[msg.sender] = 0;
        (bool ok, ) = payable(msg.sender).call{value: amount}("");
        require(ok, "Transfer failed");
    }

    function getJobTerms(JobID_t jobId) external view returns (
        address creator, uint256 maxHourlyRate, uint256 k, uint256 quorum,
        uint256 executionTime, string memory dockerImage, uint256 escrow
    ) {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        return (job.creator, job.maxHourlyRate, job.k, job.quorum, job.executionTime, job.dockerImage, job.escrow);
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
