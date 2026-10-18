pragma solidity >=0.8.20 <0.9.0;

import {JobID_t} from "./OffBalance.sol";

// DEV ONLY. Emits the same events as OffBalance on demand, with no state or
// access checks, so client/dev/event_controller.py can drive a provider client
// through any event sequence. Event declarations must stay identical to
// OffBalance's (the controller checks this at startup).
contract OffBalanceEventMock {
    event JOB_SUBMITTED(JobID_t jobId);
    event PROVIDER_SELECTED(JobID_t jobId, address provider);
    event COMMIT_PHASE_START(JobID_t jobId, uint deadline);
    event REVEAL_PHASE_START(JobID_t jobId);
    event CONSENSUS_VERIFICATION_START(JobID_t jobId);
    event DELIVERY_PHASE_START(JobID_t jobId);
    event DELIVERED(JobID_t jobId);
    event PAID(JobID_t jobId, address provider);
    event SLASHED(JobID_t jobId, address provider);
    event CANCELED(JobID_t jobId);
    event NO_QUORUM(JobID_t jobId);

    function jobSubmitted(JobID_t jobId) external { emit JOB_SUBMITTED(jobId); }

    function providersSelected(JobID_t jobId, address[] calldata providers) external {
        for (uint256 i = 0; i < providers.length; i++) {
            emit PROVIDER_SELECTED(jobId, providers[i]);
        }
    }

    function commitPhaseStart(JobID_t jobId, uint deadline) external { emit COMMIT_PHASE_START(jobId, deadline); }
    function revealPhaseStart(JobID_t jobId) external { emit REVEAL_PHASE_START(jobId); }
    function consensusVerificationStart(JobID_t jobId) external { emit CONSENSUS_VERIFICATION_START(jobId); }
    function deliveryPhaseStart(JobID_t jobId) external { emit DELIVERY_PHASE_START(jobId); }
    function delivered(JobID_t jobId) external { emit DELIVERED(jobId); }
    function paid(JobID_t jobId, address provider) external { emit PAID(jobId, provider); }
    function slashed(JobID_t jobId, address provider) external { emit SLASHED(jobId, provider); }
    function canceled(JobID_t jobId) external { emit CANCELED(jobId); }
    function noQuorum(JobID_t jobId) external { emit NO_QUORUM(jobId); }
}
