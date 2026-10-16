pragma solidity >=0.8.20 <0.9.0;

type JobID_t is uint256; // type alias for jobIDs

// helper function to compare user-defined jobId type
function compareJobIds(JobID_t a, JobID_t b) pure returns (bool) {
    return JobID_t.unwrap(a) == JobID_t.unwrap(b);
}

using {compareJobIds as ==} for JobID_t global;

contract OffBalance {
    // ------ necessary types ----------
    type Result_t is uint256; // not sure how to represent results yet either
    enum Status { JOB_SUBMITTED, PROVIDER_SELECTED, COMMIT, REVEAL, CONSENSUS, DELIVERING, DELIVERED, PAID, CANCELED, NO_QUORUM }

    struct Commitment_t {
        bool winning; // is this a winning answer?
        uint hash; // not sure what type the hash should actually be
        bool delivered; // was it delivered?
    }

    // job struct
    struct Job {
        address creator;
        JobID_t id;
        uint price;
        uint k;
        uint quorum;
        uint executionTime;
        Status status;

        uint256 commitDeadline;
        uint256 revealDeadline;
        uint256 deliveryDeadline;

        // the following will allow quorum calculation
        address[] assignedProviders;
        mapping(address => Result_t) answers;

        // final result
        Result_t acceptedAnswer;
    }

    struct Provider {
        address addr;
        JobID_t[] jobsAssigned;
        mapping(JobID_t => Commitment_t) answers; // commits per job
    }

    // ---------- define events --------------
    event JOB_SUBMITTED(JobID_t jobId);

    // posted by matcher
    event PROVIDER_SELECTED(JobID_t jobId, address provider);

    event COMMIT_PHASE_START(JobID_t jobId);
    event REVEAL_PHASE_START(JobID_t jobId);
    event CONSENSUS_VERIFICATION_START(JobID_t jobId);
    event DELIVERY_PHASE_START(JobID_t jobId);
    event DELIVERED(JobID_t jobId);

    event PAID(JobID_t jobId, address provider);
    event SLASHED(JobID_t jobId, address provider);

    event CANCELED(JobID_t jobId);
    event NO_QUORUM(JobID_t jobId);
    // -------- end of defining events ------

    // ------- data variables necessary for the contract -------//
    address server;
    mapping(JobID_t => Job) jobs;
    mapping(address => Provider) providers;

    uint public constant REVEAL_WINDOW = 120; // 120 seconds
    uint public constant DELIVERY_WINDOW = 300; // standard delivery window, since it could be a big file, lets do more time
    // ------- data variables necessary for the contract -------//

    // freeze server address at contract creation time
    constructor() {
        server = msg.sender;
    }

    // ==========functions for buyers========== //
    function submitJob(JobID_t jobId, uint price, uint k, uint quorum, uint executionTime) public {
        // creates jobStruct and puts into mapping, notifies status
        Job storage job = jobs[jobId];
        job.creator = msg.sender;
        job.id = jobId;
        job.price = price;
        job.k = k;
        job.quorum = quorum;
        job.executionTime = executionTime;
        job.status = Status.JOB_SUBMITTED;

        emit JOB_SUBMITTED(jobId);
    }

    function cancelJob(JobID_t jobId) public {
        require(msg.sender == jobs[jobId].creator);
        jobs[jobId].status = Status.CANCELED;
        emit CANCELED(jobId);
    }
    // ==========functions for buyers========== //

    // ==========functions for providers========== //
    function submitCommitment(JobID_t jobId, Commitment_t calldata commitment) private {
        require(block.timestamp < jobs[jobId].commitDeadline);
        // logic for commitment
    }

    function submitReveal(JobID_t jobId) private {
        require(block.timestamp < jobs[jobId].revealDeadline);
        // logic for revealing
    }
    // ==========functions for providers========== //

    // ==========functions for server============ //
    /*
     * Server calls this when it finds the matches for the job
     */
    function assignProviders(JobID_t jobId, address[] calldata providerAddresses) private {
        require(msg.sender == server); // only server can call this
        require(jobs[jobId].status == Status.JOB_SUBMITTED); // only if it's a new job

        // assign providers and emit providers selected
        for (uint256 i = 0; i < providerAddresses.length; i++) {
            address addr = providerAddresses[i];
            // create a provider
            Provider storage provider = providers[addr];
            provider.addr = addr; // provider may have not been created yet
            provider.jobsAssigned.push(jobId);

            jobs[jobId].assignedProviders.push(addr);
            emit PROVIDER_SELECTED(jobId, addr);
        }

        // status starts the commit phase
        jobs[jobId].status = Status.COMMIT;
        jobs[jobId].commitDeadline = block.timestamp + jobs[jobId].executionTime;

        emit COMMIT_PHASE_START(jobId);
    }

    // server verifies the receipt for a provider
    function verifyReceipt(JobID_t jobId, address provider) private {
        require(block.timestamp < jobs[jobId].deliveryDeadline); // must be in delivery window
        require(msg.sender == server); // only server calls this
        require(providers[provider].answers[jobId].winning); // must be winning

        providers[provider].answers[jobId].delivered = true;
    }

    // driver functions that do state transitions //

    //  end commit phase, start reveal
    function startRevealPhase(JobID_t jobId) private {
        require(block.timestamp > jobs[jobId].commitDeadline);
        require(jobs[jobId].status == Status.COMMIT); // must be in commit phase before this
        jobs[jobId].revealDeadline = block.timestamp + REVEAL_WINDOW;
        jobs[jobId].status = Status.REVEAL;
        emit REVEAL_PHASE_START(jobId);
    }

    function calculateConsensus(JobID_t jobId) private {
        require (jobs[jobId].status == Status.REVEAL);
        require (block.timestamp > jobs[jobId].revealDeadline);
        
        jobs[jobId].status = Status.CONSENSUS;
        
        // logic for calculating the quorum
    }

    // end reveal, start delivery
    function endRevealPhase(JobID_t jobId) private {
        require(block.timestamp > jobs[jobId].revealDeadline);
        require(jobs[jobId].status == Status.REVEAL);

        calculateConsensus(jobId);

        jobs[jobId].deliveryDeadline = block.timestamp + DELIVERY_WINDOW;
        jobs[jobId].status = Status.DELIVERING;

        emit DELIVERY_PHASE_START(jobId);
    }

    // end, trigger payout
    function endDeliveryPhase(JobID_t jobId) private {
        require(block.timestamp > jobs[jobId].deliveryDeadline);
        require(jobs[jobId].status == Status.DELIVERING);

        jobs[jobId].status = Status.DELIVERED;
        payWinnersAndSlashLosers(jobId);
        emit DELIVERED(jobId);
    }

    function payWinnersAndSlashLosers(JobID_t jobId) private {
        require(jobs[jobId].status == Status.DELIVERED);
        
        for (uint256 i = 0; i < jobs[jobId].assignedProviders.length; i++) {
            Provider storage provider = providers[jobs[jobId].assignedProviders[i]];
            
            // payout logic on provider,
            // need to also mark them in the jobs[jobId].winning providers

            // emit paid or slashed

            // emit PAID(jobId, provider.addr); 
            // emit SLASHED(jobId, provider.addr);
        }
    }



}