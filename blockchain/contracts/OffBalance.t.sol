// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {OffBalance, JobID_t} from "./OffBalance.sol";

contract OffBalanceTest is Test {
    OffBalance ob;

    uint256 constant PRICE = 1 ether;
    uint256 constant EXEC = 60;
    uint256 constant P1_KEY = 0xA1;
    uint256 constant P2_KEY = 0xA2;
    uint256 constant P3_KEY = 0xA3;
    uint256 constant P4_KEY = 0xA4;
    uint256 constant SESSION_KEY = 0xB1;
    uint256 constant ATTACKER_KEY = 0xC1;

    address buyer = makeAddr("buyer");
    address p1 = vm.addr(P1_KEY);
    address p2 = vm.addr(P2_KEY);
    address p3 = vm.addr(P3_KEY);
    address p4 = vm.addr(P4_KEY);
    address session = vm.addr(SESSION_KEY);
    address attacker = vm.addr(ATTACKER_KEY);

    uint256 S; // base STAKE

    function setUp() public {
        ob = new OffBalance(); // this test contract is the server
        S = ob.STAKE();
        vm.deal(buyer, 100 ether);
        vm.deal(p1, 100 ether);
        vm.deal(p2, 100 ether);
        vm.deal(p3, 100 ether);
        vm.deal(p4, 100 ether);
        vm.deal(session, 100 ether);
        vm.deal(attacker, 100 ether);
    }

    // ───────────── helpers ─────────────

    function _submit(uint256 k, uint256 quorum) internal returns (JobID_t id) {
        vm.prank(buyer);
        id = ob.submitJob{value: PRICE}(PRICE, k, quorum, EXEC, "img");
    }

    function _assign(JobID_t id, address[] memory ps) internal {
        ob.assignProviders(id, ps);
    }

    function _required(JobID_t id, address p) internal view returns (uint256 r) {
        (,,,, r,) = ob.getProviderCommitment(id, p);
    }

    function _stake(JobID_t id, address p) internal {
        uint256 r = _required(id, p);
        vm.prank(p);
        ob.submitStake{value: r}(id);
    }

    function _commitment(bytes memory output, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(output), salt));
    }

    function _salt(address p) internal pure returns (bytes32) {
        return keccak256(abi.encode(p));
    }

    function _list(address a, address b, address c) internal pure returns (address[] memory l) {
        l = new address[](3);
        (l[0], l[1], l[2]) = (a, b, c);
    }

    function _list4(address a, address b, address c, address d) internal pure returns (address[] memory l) {
        l = new address[](4);
        (l[0], l[1], l[2], l[3]) = (a, b, c, d);
    }

    // Run a job through to the end of the reveal window. outputs[i] == "" means provider i stakes
    // but never commits.
    function _runToRevealEnd(uint256 k, address[] memory ps, bytes[] memory outputs) internal returns (JobID_t id) {
        id = _submit(k, ps.length);
        _assign(id, ps);
        for (uint256 i; i < ps.length; ++i) _stake(id, ps[i]);
        ob.finalizeProviderSelection(id);
        for (uint256 i; i < ps.length; ++i) {
            if (outputs[i].length == 0) continue;
            vm.prank(ps[i]);
            ob.submitCommitment(id, _commitment(outputs[i], _salt(ps[i])));
        }
        vm.warp(block.timestamp + EXEC + 1);
        ob.startRevealPhase(id);
        for (uint256 i; i < ps.length; ++i) {
            if (outputs[i].length == 0) continue;
            vm.prank(ps[i]);
            ob.submitReveal(id, outputs[i], _salt(ps[i]));
        }
        vm.warp(block.timestamp + ob.REVEAL_WINDOW() + 1);
    }

    function _settle(JobID_t id) internal {
        ob.endRevealPhase(id);
        vm.warp(block.timestamp + ob.DELIVERY_WINDOW() + 1);
        ob.endDeliveryPhase(id);
    }

    function _bytes3(bytes memory a, bytes memory b, bytes memory c) internal pure returns (bytes[] memory o) {
        o = new bytes[](3);
        (o[0], o[1], o[2]) = (a, b, c);
    }

    function _bytes4(bytes memory a, bytes memory b, bytes memory c, bytes memory d)
        internal
        pure
        returns (bytes[] memory o)
    {
        o = new bytes[](4);
        (o[0], o[1], o[2], o[3]) = (a, b, c, d);
    }

    function _status(JobID_t id) internal view returns (uint8) {
        return uint8(ob.getJobStatus(id));
    }

    // Every wei the contract holds is owed to someone or locked as stake.
    function _assertSolvent(address[] memory everyone) internal view {
        uint256 owed;
        for (uint256 i; i < everyone.length; ++i) owed += ob.credits(everyone[i]) + ob.lockedStake(everyone[i]);
        assertEq(address(ob).balance, owed, "contract balance != credits + locked stake");
    }

    function _everyone() internal view returns (address[] memory e) {
        e = new address[](5);
        (e[0], e[1], e[2], e[3], e[4]) = (buyer, p1, p2, p3, p4);
    }

    // ───────────── scaling stake ─────────────

    function test_NewProviderStakesSixTimesBase() public view {
        assertEq(ob.stakeFor(p1), 6 * S);
    }

    function test_StakeShrinksWithReputationAndGrowsBackOnSlash() public {
        bytes memory a = "aa";
        JobID_t id = _runToRevealEnd(2, _list(p1, p2, p3), _bytes3(a, a, "bb"));
        _settle(id);
        assertEq(ob.reputationOf(p1), 1);
        assertEq(ob.reputationOf(p3), 0); // slashed, floored at 0
        // rep 1: extra = 5S - 5S * 1 / 2000
        assertEq(ob.stakeFor(p1), S + 5 * S - (5 * S) / 2000);
        assertLt(ob.stakeFor(p1), ob.stakeFor(p3));
    }

    // ───────────── stake fixed at assign time ─────────────

    function test_StakeIsFixedAtAssignment() public {
        // job2 assigned to p1 while p1 is still a new provider
        JobID_t job2 = _submit(1, 1);
        address[] memory only1 = new address[](1);
        only1[0] = p1;
        _assign(job2, only1);
        uint256 assignedAt = block.timestamp;
        assertEq(_required(job2, p1), 6 * S);

        // p1 then wins job1 and gains reputation, lowering its current stakeFor
        bytes memory a = "aa";
        JobID_t job1 = _runToRevealEnd(2, _list(p1, p2, p3), _bytes3(a, a, a));
        _settle(job1);
        uint256 lower = ob.stakeFor(p1);
        assertLt(lower, 6 * S);
        // back inside job2's staking window (job1 took longer than the demo-length window)
        vm.warp(assignedAt + 1);

        // job2 still requires the amount fixed at assignment
        vm.prank(p1);
        vm.expectRevert("Incorrect stake");
        ob.submitStake{value: lower}(job2);
        _stake(job2, p1);
        (,,,,, uint256 staked) = ob.getProviderCommitment(job2, p1);
        assertEq(staked, 6 * S);
    }

    function test_StakeRules() public {
        JobID_t id = _submit(2, 3);
        _assign(id, _list(p1, p2, p3));

        vm.prank(p4);
        vm.expectRevert("Provider not assigned");
        ob.submitStake{value: 6 * S}(id);

        vm.prank(p1);
        vm.expectRevert("Incorrect stake");
        ob.submitStake{value: 6 * S - 1}(id);

        _stake(id, p1);
        vm.prank(p1);
        vm.expectRevert("Stake already submitted");
        ob.submitStake{value: 6 * S}(id);
        assertEq(ob.lockedStake(p1), 6 * S);

        vm.warp(block.timestamp + ob.PENDING_WINDOW() + 1);
        vm.prank(p2);
        vm.expectRevert("Staking window passed");
        ob.submitStake{value: 6 * S}(id);
    }

    function test_CommitNoLongerTakesStake() public {
        JobID_t id = _submit(1, 1);
        address[] memory only1 = new address[](1);
        only1[0] = p1;
        _assign(id, only1);
        _stake(id, p1);
        ob.finalizeProviderSelection(id);
        vm.prank(p1);
        ob.submitCommitment(id, _commitment("aa", _salt(p1)));
        vm.prank(p1);
        vm.expectRevert("Already committed");
        ob.submitCommitment(id, _commitment("aa", _salt(p1)));
    }

    // ───────────── provider selection ─────────────

    function test_FinalizeEarlyOnlyWhenEveryoneStaked() public {
        JobID_t id = _submit(2, 3);
        _assign(id, _list(p1, p2, p3));
        _stake(id, p1);
        _stake(id, p2);
        vm.expectRevert("Staking window not ended");
        ob.finalizeProviderSelection(id);
        _stake(id, p3);
        ob.finalizeProviderSelection(id);
        assertEq(_status(id), uint8(OffBalance.Status.COMMIT));
    }

    function test_FinalizeDropsEveryUnstakedProvider() public {
        // Adjacent unstaked providers, including the last slot: checks swap-and-pop rechecks slot i.
        JobID_t id = _submit(2, 4);
        _assign(id, _list4(p1, p2, p3, p4));
        _stake(id, p1);
        _stake(id, p4);
        vm.warp(block.timestamp + ob.PENDING_WINDOW() + 1);
        ob.finalizeProviderSelection(id);

        address[] memory left = ob.getAssignedProviders(id);
        assertEq(left.length, 2);
        assertTrue((left[0] == p1 && left[1] == p4) || (left[0] == p4 && left[1] == p1));
        assertEq(_status(id), uint8(OffBalance.Status.COMMIT));

        vm.prank(p2);
        vm.expectRevert("Provider not assigned");
        ob.submitCommitment(id, _commitment("aa", _salt(p2)));
    }

    function test_TooFewStakersRefundsEveryone() public {
        JobID_t id = _submit(2, 3);
        _assign(id, _list(p1, p2, p3));
        _stake(id, p1);
        vm.warp(block.timestamp + ob.PENDING_WINDOW() + 1);
        ob.finalizeProviderSelection(id);

        assertEq(_status(id), uint8(OffBalance.Status.NO_QUORUM));
        assertEq(ob.credits(buyer), PRICE);
        assertEq(ob.credits(p1), 6 * S);
        assertEq(ob.lockedStake(p1), 0);
        _assertSolvent(_everyone());
    }

    function test_CancelDuringStakingRefundsStakes() public {
        JobID_t id = _submit(2, 3);
        _assign(id, _list(p1, p2, p3));
        _stake(id, p1);
        vm.prank(buyer);
        ob.cancelJob(id);
        assertEq(_status(id), uint8(OffBalance.Status.CANCELED));
        assertEq(ob.credits(buyer), PRICE);
        assertEq(ob.credits(p1), 6 * S);
        assertEq(ob.lockedStake(p1), 0);
        _assertSolvent(_everyone());
    }

    // ───────────── settlement and slashing ─────────────

    function test_UnanimousSplitsPrice() public {
        bytes memory a = "aa";
        JobID_t id = _runToRevealEnd(2, _list(p1, p2, p3), _bytes3(a, a, a));
        _settle(id);
        assertEq(_status(id), uint8(OffBalance.Status.PAID));
        uint256 share = PRICE / 3;
        uint256 dust = PRICE - share * 3;
        assertEq(ob.credits(p1), share + dust + 6 * S);
        assertEq(ob.credits(p2), share + 6 * S);
        assertEq(ob.credits(p3), share + 6 * S);
        assertEq(ob.credits(buyer), 0);
        _assertSolvent(_everyone());
    }

    function test_SlashesWrongAnswerAndNonCommitterAndPaysWinners() public {
        bytes memory a = "aa";
        JobID_t id = _runToRevealEnd(2, _list4(p1, p2, p3, p4), _bytes4(a, a, "bb", ""));

        ob.endRevealPhase(id);
        vm.warp(block.timestamp + ob.DELIVERY_WINDOW() + 1);
        vm.expectEmit(true, true, false, true, address(ob));
        emit OffBalance.SLASHED(id, p3, 6 * S);
        vm.expectEmit(true, true, false, true, address(ob));
        emit OffBalance.SLASHED(id, p4, 6 * S);
        ob.endDeliveryPhase(id);

        uint256 share = (PRICE + 12 * S) / 2;
        assertEq(ob.credits(p1), share + 6 * S);
        assertEq(ob.credits(p2), share + 6 * S);
        assertEq(ob.credits(p3), 0);
        assertEq(ob.credits(p4), 0);
        for (uint256 i; i < 4; ++i) assertEq(ob.lockedStake(_list4(p1, p2, p3, p4)[i]), 0);
        _assertSolvent(_everyone());
    }

    function test_NonRevealerIsSlashed() public {
        bytes memory a = "aa";
        JobID_t id = _submit(2, 3);
        _assign(id, _list(p1, p2, p3));
        _stake(id, p1);
        _stake(id, p2);
        _stake(id, p3);
        ob.finalizeProviderSelection(id);
        address[3] memory ps = [p1, p2, p3];
        for (uint256 i; i < 3; ++i) {
            vm.prank(ps[i]);
            ob.submitCommitment(id, _commitment(a, _salt(ps[i])));
        }
        vm.warp(block.timestamp + EXEC + 1);
        ob.startRevealPhase(id);
        for (uint256 i; i < 2; ++i) {
            vm.prank(ps[i]);
            ob.submitReveal(id, a, _salt(ps[i]));
        }
        vm.warp(block.timestamp + ob.REVEAL_WINDOW() + 1);
        _settle(id);
        assertEq(ob.credits(p3), 0);
        assertEq(ob.credits(p1), (PRICE + 6 * S) / 2 + 6 * S);
        _assertSolvent(_everyone());
    }

    function test_NoConsensusRefundsBuyerAndEveryStake() public {
        JobID_t id = _runToRevealEnd(2, _list(p1, p2, p3), _bytes3("aa", "bb", ""));
        vm.expectEmit(true, false, false, false, address(ob));
        emit OffBalance.NO_QUORUM(id);
        ob.endRevealPhase(id); // must not revert, or the refunds would be rolled back

        assertEq(_status(id), uint8(OffBalance.Status.NO_QUORUM));
        assertEq(ob.credits(buyer), PRICE);
        assertEq(ob.credits(p1), 6 * S);
        assertEq(ob.credits(p2), 6 * S);
        assertEq(ob.credits(p3), 6 * S); // staked but never committed: still refunded
        assertEq(ob.reputationOf(p1), 0);
        _assertSolvent(_everyone());

        vm.expectRevert("Not in delivery phase");
        ob.endDeliveryPhase(id);
    }

    function test_ConsensusNeedsKNotEveryone() public {
        // quorum 3, k 2: two matching reveals are enough
        bytes memory a = "aa";
        JobID_t id = _runToRevealEnd(2, _list(p1, p2, p3), _bytes3(a, a, "bb"));
        ob.endRevealPhase(id);
        assertEq(_status(id), uint8(OffBalance.Status.DELIVERING));
    }

    function test_Withdraw() public {
        bytes memory a = "aa";
        JobID_t id = _runToRevealEnd(2, _list(p1, p2, p3), _bytes3(a, a, a));
        _settle(id);
        uint256 owed = ob.credits(p2);
        uint256 before = p2.balance;
        vm.prank(p2);
        ob.withdraw();
        assertEq(p2.balance, before + owed);
        vm.prank(p2);
        vm.expectRevert("No credit");
        ob.withdraw();
    }

    // ───────────── session keys ─────────────

    function _sign(uint256 key, address owner, address sk, uint64 expiresAt) internal view returns (bytes memory) {
        bytes32 digest = ob.sessionKeyDigest(owner, sk, expiresAt);
        bytes32 h = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, h);
        return abi.encodePacked(r, s, v);
    }

    function _register(address owner, uint256 skKey, uint64 expiresAt) internal {
        address sk = vm.addr(skKey);
        bytes memory sig = _sign(skKey, owner, sk, expiresAt);
        vm.prank(owner);
        ob.registerSessionKey(sk, expiresAt, sig);
    }

    function test_SessionKeyActsForOwnerAndOwnerGetsPaid() public {
        uint64 exp = uint64(block.timestamp + 7 days);
        _register(p1, SESSION_KEY, exp);
        (address owner, uint64 e) = ob.sessionKeys(session);
        assertEq(owner, p1);
        assertEq(e, exp);
        assertEq(ob.activeSessionKey(p1), session);
        assertEq(ob.providerOf(session), p1);

        bytes memory a = "aa";
        JobID_t id = _submit(2, 3);
        _assign(id, _list(p1, p2, p3));

        // session key stakes, commits and reveals for p1
        vm.prank(session);
        ob.submitStake{value: 6 * S}(id);
        _stake(id, p2);
        _stake(id, p3);
        ob.finalizeProviderSelection(id);
        vm.prank(session);
        ob.submitCommitment(id, _commitment(a, _salt(p1)));
        vm.prank(p2);
        ob.submitCommitment(id, _commitment(a, _salt(p2)));
        vm.warp(block.timestamp + EXEC + 1);
        ob.startRevealPhase(id);
        vm.prank(session);
        ob.submitReveal(id, a, _salt(p1));
        vm.prank(p2);
        ob.submitReveal(id, a, _salt(p2));
        vm.warp(block.timestamp + ob.REVEAL_WINDOW() + 1);
        _settle(id);

        uint256 share = (PRICE + 6 * S) / 2;
        assertEq(ob.credits(p1), share + 6 * S);
        assertEq(ob.credits(session), 0);
        vm.prank(session);
        vm.expectRevert("No credit");
        ob.withdraw();
    }

    function test_RegisterForwardsFundingToSessionKey() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(SESSION_KEY, p1, session, exp);
        uint256 before = session.balance;
        vm.prank(p1);
        ob.registerSessionKey{value: 0.05 ether}(session, exp, sig);
        assertEq(session.balance, before + 0.05 ether);
        assertEq(address(ob).balance, 0);
    }

    function test_SessionKeyRejectsBadOrStolenSignatures() public {
        uint64 exp = uint64(block.timestamp + 1 days);

        // signed by someone other than the key
        bytes memory wrong = _sign(ATTACKER_KEY, p1, session, exp);
        vm.prank(p1);
        vm.expectRevert("Bad session key signature");
        ob.registerSessionKey(session, exp, wrong);

        // signature for a different owner can't be reused
        bytes memory forP2 = _sign(SESSION_KEY, p2, session, exp);
        vm.prank(p1);
        vm.expectRevert("Bad session key signature");
        ob.registerSessionKey(session, exp, forP2);

        // attacker can't claim provider p2's address as its session key without p2's signature
        bytes memory own = _sign(ATTACKER_KEY, attacker, p2, exp);
        vm.prank(attacker);
        vm.expectRevert("Bad session key signature");
        ob.registerSessionKey(p2, exp, own);

        bytes memory expired = _sign(SESSION_KEY, p1, session, uint64(block.timestamp));
        vm.prank(p1);
        vm.expectRevert("Expiry in the past");
        ob.registerSessionKey(session, uint64(block.timestamp), expired);
    }

    function test_SessionKeyCannotBeTakenOrReplayed() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        bytes memory sig = _sign(SESSION_KEY, p1, session, exp);
        vm.prank(p1);
        ob.registerSessionKey(session, exp, sig);

        // another owner can't take a live key, even with a valid signature
        bytes memory forP2 = _sign(SESSION_KEY, p2, session, exp);
        vm.prank(p2);
        vm.expectRevert("Session key bound to another owner");
        ob.registerSessionKey(session, exp, forP2);

        // after revoking, the old authorization can't be replayed (nonce moved on)
        vm.prank(p1);
        ob.revokeSessionKey();
        assertEq(ob.providerOf(session), session);
        vm.prank(p1);
        vm.expectRevert("Bad session key signature");
        ob.registerSessionKey(session, exp, sig);
    }

    function test_RegisteringReplacesPreviousKey() public {
        uint64 exp = uint64(block.timestamp + 1 days);
        _register(p1, SESSION_KEY, exp);
        _register(p1, ATTACKER_KEY, exp); // any second key
        assertEq(ob.activeSessionKey(p1), attacker);
        assertEq(ob.providerOf(session), session);
        (address owner,) = ob.sessionKeys(session);
        assertEq(owner, address(0));
    }

    function test_ExpiredSessionKeyNoLongerActs() public {
        _register(p1, SESSION_KEY, uint64(block.timestamp + 10));
        JobID_t id = _submit(2, 3);
        _assign(id, _list(p1, p2, p3));
        vm.warp(block.timestamp + 10); // expired, but staking is still open
        assertEq(ob.providerOf(session), session);
        vm.prank(session);
        vm.expectRevert("Provider not assigned");
        ob.submitStake{value: 6 * S}(id);
    }

    function test_CannotAssignASessionKey() public {
        _register(p1, SESSION_KEY, uint64(block.timestamp + 1 days));
        JobID_t id = _submit(2, 3);
        vm.expectRevert("Assign the owner, not its session key");
        _assign(id, _list(session, p2, p3));
    }
}
