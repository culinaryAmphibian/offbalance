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
        // Initial provider addresses have been selected; staking is still open.
        PROVIDER_SELECTED, // identical to COMMIT_STAKE
        // The pending window has closed and the staked provider set is finalized.
        PROVIDERS_CONFIRMED,
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
        uint256 pendingDeadline;
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
        address payable addr;
        uint16 reputation;
        JobID_t[] jobsAssigned;
        mapping(JobID_t => Commitment_t) answers;
    }

    event JOB_SUBMITTED(JobID_t indexed jobId);
    event PROVIDER_SELECTED(JobID_t indexed jobId, address indexed provider);

    // Emitted once the staking window closes and the eligible provider set is finalized.
    event PROVIDERS_SELECTED(JobID_t indexed jobId, uint256 providerCount);

    event COMMIT_STAKE_PHASE_START(JobID_t indexed jobId, uint256 deadline, uint256 stake);
    event COMMIT_PHASE_START(JobID_t indexed jobId, uint256 deadline);
    event REVEAL_PHASE_START(JobID_t indexed jobId, uint256 deadline);
    event CONSENSUS_VERIFICATION_START(JobID_t indexed jobId);
    event DELIVERY_PHASE_START(JobID_t indexed jobId, uint256 deadline);
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
    mapping(bytes32 => uint256) private temp_hashes;

    // Providers have this long (in seconds) after assignment to deposit their required stake.
    uint256 public constant PENDING_WINDOW = 60 * 60 * 24;
    uint256 public constant REVEAL_WINDOW = 120;
    uint256 public constant DELIVERY_WINDOW = 300;

    modifier onlyServer() {
        require(msg.sender == server, "Only server");
        _; // Continue executing the protected function after the access check.
    }

    constructor() {
        server = msg.sender;
    }

    // Buyer escrows the full job price and specifies the stake required from each provider.
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
        job.stakeAmount = 1000000000;
        job.k = k;
        job.quorum = quorum;
        job.executionTime = executionTime;
        job.status = Status.JOB_SUBMITTED;
        job.dockerImgName = dockerName;

        // The commitment deadline is set only after provider staking is finalized.

        emit JOB_SUBMITTED(jobId);
        return true;
    }

    function cancelJob(JobID_t jobId) external returns (bool) {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        require(msg.sender == job.creator, "Only buyer");
        require(job.status == Status.JOB_SUBMITTED || job.status == Status.PROVIDER_SELECTED, "Job no longer pending");
        job.status = Status.CANCELED;
        credits[job.creator] += job.price;				// Refund the buyer through the pull-payment credit balance.
		if (job.status == Status.PROVIDER_SELECTED)
			_returnAllStakesToCredits(jobId);
        emit CANCELED(jobId);
        return true;
    }

    // Providers deposit their stake during the pending provider-selection window.
    // The window begins when the server assigns the initial provider set.
    function submitStake(JobID_t jobId) external payable {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        require(job.status == Status.PROVIDER_SELECTED, "Not in staking phase");
        require(block.timestamp <= job.pendingDeadline, "Staking window passed");
        require(job.isAssigned[msg.sender], "Provider not assigned");
        require(msg.value == job.stakeAmount * (1 + 5 * 2 ** providers[msg.sender].reputation), "Incorrect stake");
        Commitment_t storage c = providers[msg.sender].answers[jobId];
        require(c.stake == 0, "Stake already submitted");
        c.stake = msg.value; 												// Record the deposited stake. No stake is required in submitCommitment().
    }

    // A commitment uses the stake already deposited in submitStake().
    function submitCommitment(JobID_t jobId, bytes32 commitmentHash) external {
        Job storage job = jobs[jobId];
        require(job.status == Status.COMMIT, "Not in commit phase");
        require(block.timestamp <= job.commitDeadline, "Commit deadline passed");
        require(job.isAssigned[msg.sender], "Provider not assigned");
        require(commitmentHash != bytes32(0), "Empty commitment");
        Commitment_t storage c = providers[msg.sender].answers[jobId];
        require(c.stake == job.stakeAmount, "Stake not deposited");
        require(c.commitmentHash == bytes32(0), "Already committed");
        c.commitmentHash = commitmentHash;
        emit COMMITTED(jobId, msg.sender);
    }

    // Reveal the entire output and salt; invalid reveals revert and cannot count toward consensus.
    function submitReveal(JobID_t jobId, bytes calldata output, bytes32 salt) external {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp <= job.revealDeadline, "Reveal deadline passed");
        require(job.isAssigned[msg.sender], "Provider not assigned");
        Commitment_t storage c = providers[msg.sender].answers[jobId];
        require(c.commitmentHash != bytes32(0), "No commitment");
        require(!c.revealed, "Already revealed");
        bytes32 outputHash = keccak256(output);
        require(keccak256(abi.encode(outputHash, salt)) == c.commitmentHash, "Reveal does not match commitment");

        c.outputHash = outputHash;
        c.revealed = true;
        job.answers[msg.sender] = Result_t.wrap(uint256(outputHash));
        emit REVEALED(jobId, msg.sender, outputHash);
    }

    // The server proposes the initial provider set and opens the staking window.
    function assignProviders(JobID_t jobId, address[] calldata providerAddresses) external onlyServer {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        require(job.status == Status.JOB_SUBMITTED, "Job not awaiting assignment");
        require(providerAddresses.length == job.quorum, "Must assign exact quorum");

        for (uint256 i = 0; i < providerAddresses.length; ++i) {
            address addr = providerAddresses[i];
            require(addr != address(0), "Zero provider address");
            require(!job.isAssigned[addr], "Duplicate provider");
            job.isAssigned[addr] = true;
            job.assignedProviders.push(addr);
            providers[addr].addr = payable(addr);					// just in case
            providers[addr].jobsAssigned.push(jobId);
            emit PROVIDER_SELECTED(jobId, addr, 1 + );
        }
        job.status = Status.PROVIDER_SELECTED;
        job.pendingDeadline = block.timestamp + PENDING_WINDOW;
        emit COMMIT_STAKE_PHASE_START(jobId, job.pendingDeadline, job.stakeAmount * (1 + 5 * 2 ** providers[msg.sender].reputation));
    }

    // Finalize the provider set after the staking window.
    // Unstaked providers are removed.
    // If fewer than k providers staked, refund the buyer and every provider who did stake.
    function finalizeProviderSelection(JobID_t jobId) external {
        Job storage job = jobs[jobId];
        require(job.creator != address(0), "Unknown job");
        require(job.status == Status.PROVIDER_SELECTED, "Not in staking phase");
        require(block.timestamp > job.pendingDeadline, "Staking window not ended");
        uint256 i = 0;
        // Remove providers who did not deposit their stake.
        // Swap-and-pop avoids leaving gaps in the assignedProviders array.
        while (i < job.assignedProviders.length) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            if (c.stake == 0) {
                job.isAssigned[addr] = false;
                job.assignedProviders[job.assignedProviders.length - 1] = job.assignedProviders[i]; // it was assigning it the other way around
                job.assignedProviders.pop();
            }
        	++i;																					// it was only incrementing i if c.stake was not 0
        }
        // The provider-selection result is now final, whether or not enough
        // providers staked. Emit this only after the pending window has elapsed
        // and every provider who failed to stake has been removed.
        job.status = Status.PROVIDERS_CONFIRMED;
        emit PROVIDERS_SELECTED(jobId, job.assignedProviders.length);
        if (job.assignedProviders.length < job.quorum) {
            // The job cannot reach consensus. Return the buyer's escrow and every
            // deposited stake to pull-payment credits; no ETH is sent in this loop.
            job.status = Status.NO_QUORUM;
            credits[job.creator] += job.price;
            _returnAllStakesToCredits(jobId, job);
            emit NO_QUORUM(jobId);
            return;
        }

        // Enough providers staked, so the job can proceed to commitments.
        job.status = Status.COMMIT;
        job.commitDeadline = block.timestamp + job.executionTime;
        emit COMMIT_PHASE_START(jobId, job.commitDeadline);
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
        // Everyone who did not commit will not be able to reveal.
        job.revealDeadline = block.timestamp + REVEAL_WINDOW;
        job.status = Status.REVEAL;
        emit REVEAL_PHASE_START(jobId, job.revealDeadline);
    }

    // If consensus fails, the buyer and all providers receive refunds through credits.
    function calculateConsensus(JobID_t jobId) private {
        Job storage job = jobs[jobId];
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp > job.revealDeadline, "Reveal phase not ended");
        emit CONSENSUS_VERIFICATION_START(jobId);

        // Reset the temporary counters for all output hashes in this job.
        for (uint256 i = 0; i < job.assignedProviders.length; i++) {
            address candidate = job.assignedProviders[i];
            bytes32 candidateHash = providers[candidate].answers[jobId].outputHash;
            temp_hashes[candidateHash] = 0;
        }

        bytes32 bestHash;
        uint256 bestCount = 0;
        // Count how many providers revealed each output hash.
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

        if (bestCount >= job.quorum) {
            job.acceptedAnswer = Result_t.wrap(uint256(bestHash));
            job.consensusCount = bestCount;
            // Mark providers whose revealed output matches the consensus output.
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
            // No consensus: return the buyer's escrow and all provider stakes as credits.
            credits[job.creator] += job.price;
            _returnAllStakesToCredits(jobId, job);
        }
    }

    function endRevealPhase(JobID_t jobId) public {
        Job storage job = jobs[jobId];
        require(job.status == Status.REVEAL, "Not in reveal phase");
        require(block.timestamp > job.revealDeadline, "Reveal phase not ended");
        calculateConsensus(jobId);
        require (job.status != Status.NO_QUORUM, "Consensus was not reached");

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
        uint256 winners = 0;
        for (uint256 i; i < job.assignedProviders.length; ++i) {
            if (providers[job.assignedProviders[i]].answers[jobId].winning) {
                ++winners;
            }
        }
        require(winners >= job.k, "Consensus invariant failed");

        uint256 share = job.price / winners;

        for (uint256 i = 0; i < job.assignedProviders.length; ++i) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            if (c.winning) {
                uint256 amount = share;
                credits[addr] += amount + c.stake;
                if (providers[addr].reputation < type(uint16).max) providers[addr].reputation += 1;
                emit PAID(jobId, addr, amount);
                c.stake = 0;
            } else if (c.stake > 0) {
                uint256 amountSlashed = c.stake;
                if (providers[addr].reputation > 0) providers[addr].reputation -= 1;
                // Unsuccessful providers lose their stake; it remains in the contract.
                emit SLASHED(jobId, addr, amountSlashed);
                c.stake = 0;
            }
        }
        job.status = Status.PAID;
    }

    // Return every deposited stake to its provider's pull-payment credit balance.
    // This is a refund, not a slash: used when a job cannot proceed or reach consensus.
    // In the provider-selection failure case, the assigned list contains only stakers,
    // because providers who did not stake were removed before this function is called.
    function _returnAllStakesToCredits(JobID_t jobId) private {
		Job job = jobs[jobId];
        for (uint256 i; i < job.assignedProviders.length; ++i) {
            address addr = job.assignedProviders[i];
            Commitment_t storage c = providers[addr].answers[jobId];
            if (c.stake > 0) {
                uint256 amount = c.stake;
                c.stake = 0;
                credits[addr] += amount;
            }
        }
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

    function getAssignedProviders(JobID_t jobId) external view returns (address[] memory) {
        return jobs[jobId].assignedProviders;
    }

    function getProviderCommitment(
        JobID_t jobId,
        address provider
    )
        external
        view
        returns (
            bytes32 commitmentHash,
            bytes32 outputHash,
            bool revealed,
            bool winning,
            bool delivered,
            uint256 stake
        )
    {
        Commitment_t storage c = providers[provider].answers[jobId];

        return (
            c.commitmentHash,
            c.outputHash,
            c.revealed,
            c.winning,
            c.delivered,
            c.stake
        );
    }
}