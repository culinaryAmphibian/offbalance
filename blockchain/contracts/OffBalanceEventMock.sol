// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {JobID_t} from "./OffBalance.sol";

// DEV ONLY. Emits the same events as OffBalance on demand, with no state or
// access checks, so client/dev/event_controller.py can drive a provider client
// through any event sequence. Event declarations must stay identical to
// OffBalance's (the controller checks this at startup).
contract OffBalanceEventMock {
    event JOB_SUBMITTED(JobID_t indexed jobId);
    event PROVIDER_SELECTED(JobID_t indexed jobId, address indexed provider);
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

    function jobSubmitted(JobID_t jobId) external { emit JOB_SUBMITTED(jobId); }

    function providersSelected(JobID_t jobId, address[] calldata providers) external {
        for (uint256 i = 0; i < providers.length; i++) {
            emit PROVIDER_SELECTED(jobId, providers[i]);
        }
    }

    function commitPhaseStart(JobID_t jobId, uint256 deadline) external { emit COMMIT_PHASE_START(jobId, deadline); }
    function revealPhaseStart(JobID_t jobId) external { emit REVEAL_PHASE_START(jobId); }
    function consensusVerificationStart(JobID_t jobId) external { emit CONSENSUS_VERIFICATION_START(jobId); }
    function deliveryPhaseStart(JobID_t jobId) external { emit DELIVERY_PHASE_START(jobId); }
    function delivered(JobID_t jobId) external { emit DELIVERED(jobId); }
    function paid(JobID_t jobId, address provider, uint256 amount) external { emit PAID(jobId, provider, amount); }
    function slashed(JobID_t jobId, address provider, uint256 amount) external { emit SLASHED(jobId, provider, amount); }
    function canceled(JobID_t jobId) external { emit CANCELED(jobId); }
    function noQuorum(JobID_t jobId) external { emit NO_QUORUM(jobId); }
    function committed(JobID_t jobId, address provider) external { emit COMMITTED(jobId, provider); }
    function revealed(JobID_t jobId, address provider, bytes32 outputHash) external { emit REVEALED(jobId, provider, outputHash); }
    function consensusReached(JobID_t jobId, bytes32 outputHash, uint256 count) external { emit CONSENSUS_REACHED(jobId, outputHash, count); }
}