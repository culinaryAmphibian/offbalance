// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {OffBalance, JobID_t} from "../contracts/OffBalance.sol";
import {OffBalanceFixture} from "./OffBalanceFixture.sol";

// Edge cases not covered by contracts/OffBalance.t.sol: phase deadlines at their exact second,
// settlement arithmetic, the majority rule that rules out ties, the stake curve and reputation limits, session keys that expire or
// are revoked mid-job, cancellation rules, and withdraw re-entrancy.
contract OffBalanceEdgesTest is OffBalanceFixture {
    // ───────────── deadlines: the last allowed second, and one after ─────────────

    function test_StakeAtTheStakingDeadlineCountsOneSecondLaterDoesNot() public {
        JobID_t id = _submit(PRICE, 2, 2);
        ob.assignProviders(id, _first(2));
        (, uint256 pending,,,) = ob.getDeadlines(id);

        vm.warp(pending);
        _stake(id, provs[0]);

        vm.warp(pending + 1);
        uint256 r = _required(id, provs[1]);
        vm.prank(provs[1]);
        vm.expectRevert("Staking window passed");
        ob.submitStake{value: r}(id);
    }

    function test_FinalizeWaitsForTheStakingDeadlineUnlessEveryoneStaked() public {
        JobID_t id = _submit(PRICE, 2, 3);
        ob.assignProviders(id, _first(3));
        _stake(id, provs[0]);
        _stake(id, provs[1]);
        (, uint256 pending,,,) = ob.getDeadlines(id);

        vm.warp(pending);
        vm.expectRevert("Staking window not ended");
        ob.finalizeProviderSelection(id);

        vm.warp(pending + 1);
        vm.prank(makeAddr("anyone")); // anyone can close staking
        ob.finalizeProviderSelection(id);
        assertEq(_status(id), COMMIT);
        assertEq(ob.getAssignedProviders(id).length, 2, "the provider that didn't stake is dropped");
    }

    function test_CommitAtTheCommitDeadlineCountsAndRevealCannotStartUntilAfterIt() public {
        JobID_t id = _committing(PRICE, 2, _first(3));
        _commit(id, provs[2], "out");
        (,, uint256 commitDeadline,,) = ob.getDeadlines(id);

        vm.warp(commitDeadline);
        _commit(id, provs[0], "out");
        vm.expectRevert("Commit phase not ended");
        ob.startRevealPhase(id);

        vm.warp(commitDeadline + 1);
        vm.prank(provs[1]);
        vm.expectRevert("Commit deadline passed");
        ob.submitCommitment(id, _commitment("out", _salt(provs[1])));
        ob.startRevealPhase(id);
        assertEq(_status(id), REVEAL);
    }

    function test_RevealAtTheRevealDeadlineCountsAndConsensusWaitsUntilAfterIt() public {
        JobID_t id = _committing(PRICE, 2, _first(3));
        for (uint256 i; i < 3; ++i) _commit(id, provs[i], "out");
        vm.warp(block.timestamp + EXEC + 1);
        ob.startRevealPhase(id);
        _reveal(id, provs[2], "out");
        (,,, uint256 revealDeadline,) = ob.getDeadlines(id);

        vm.warp(revealDeadline);
        _reveal(id, provs[0], "out");
        vm.expectRevert("Reveal phase not ended");
        ob.endRevealPhase(id);

        vm.warp(revealDeadline + 1);
        vm.prank(provs[1]);
        vm.expectRevert("Reveal deadline passed");
        ob.submitReveal(id, "out", _salt(provs[1]));
        ob.endRevealPhase(id);
        assertEq(_status(id), DELIVERING);
    }

    function test_PayoutWaitsUntilAfterTheDeliveryDeadline() public {
        JobID_t id = _runToRevealEnd(PRICE, 2, _first(2), _outputs2("out", "out"));
        ob.endRevealPhase(id);
        (,,,, uint256 deliveryDeadline) = ob.getDeadlines(id);
        vm.warp(deliveryDeadline);
        vm.expectRevert("Delivery window not ended");
        ob.endDeliveryPhase(id);
        vm.warp(deliveryDeadline + 1);
        ob.endDeliveryPhase(id);
        assertEq(_status(id), PAID);
    }

    function test_EveryPhaseFunctionRejectsTheWrongPhase() public {
        JobID_t id = _submit(PRICE, 2, 2);
        vm.expectRevert("Not in staking phase");
        ob.finalizeProviderSelection(id);
        vm.expectRevert("Not in commit phase");
        ob.startRevealPhase(id);
        vm.expectRevert("Not in reveal phase");
        ob.endRevealPhase(id);
        vm.expectRevert("Not in delivery phase");
        ob.endDeliveryPhase(id);
        vm.prank(provs[0]);
        vm.expectRevert("Not in commit phase");
        ob.submitCommitment(id, bytes32(uint256(1)));
        vm.prank(provs[0]);
        vm.expectRevert("Not in reveal phase");
        ob.submitReveal(id, "out", bytes32(0));
    }

    // ───────────── settlement arithmetic ─────────────

    function test_PriceThatDoesntDivideEvenlyGivesTheDustToExactlyOneWinner() public {
        uint256 price = 1 ether + 1; // 3 winners
        uint256 share = price / 3;
        uint256 dust = price % 3;
        assertGt(dust, 0, "the price must leave dust for this test");
        address[] memory ps = _first(3);
        JobID_t id = _runToRevealEnd(price, 2, ps, _outputs("out", "out", "out"));
        uint256 stake = _required(id, ps[0]);
        _settle(id);

        uint256 withDust;
        for (uint256 i; i < 3; ++i) {
            uint256 got = ob.credits(ps[i]) - stake;
            assertTrue(got == share || got == share + dust, "each winner gets the share, one also gets the dust");
            if (got == share + dust) ++withDust;
        }
        assertEq(withDust, 1, "the dust goes to exactly one winner");
        assertEq(address(ob).balance, _owed(), "nothing is left unaccounted for");
    }

    function test_WinnersSplitThePriceAndEverySlashedStake() public {
        address[] memory ps = _first(5);
        // 3 of 5 must agree: p4 gives a different answer, p5 never commits
        JobID_t id = _runToRevealEnd(PRICE, 3, ps, _outputs("out", "out", "out", "wrong", ""));
        uint256[5] memory stakes;
        for (uint256 i; i < 5; ++i) stakes[i] = _required(id, ps[i]);
        _settle(id);

        uint256 pool = PRICE + stakes[3] + stakes[4];
        assertEq(ob.credits(ps[0]) + ob.credits(ps[1]) + ob.credits(ps[2]), pool + stakes[0] + stakes[1] + stakes[2],
            "winners get the pool plus their stakes");
        assertEq(ob.credits(ps[3]), 0);
        assertEq(ob.credits(ps[4]), 0);
        assertEq(ob.credits(buyer), 0);
        assertEq(address(ob).balance, _owed());
    }

    function test_ASingleProviderJobNeedsOnlyItsOwnAnswer() public {
        JobID_t id = _runToRevealEnd(PRICE, 1, _first(1), _outputs1("a"));
        _settle(id);
        assertEq(_status(id), PAID);
        assertEq(ob.credits(provs[0]), PRICE + _required(id, provs[0]));
    }

    // B6 in TESTING_PLAN.md: more than half the providers must agree (2k > quorum), checked when
    // the job is submitted. Two different answers can then never both reach k, so consensus can't
    // tie (before, a 2-2 split with k = 2 paid the earlier-revealed pair and slashed the other).
    function test_SubmitRequiresMoreThanHalfTheProvidersToAgree() public {
        uint256[2][6] memory invalid = [[uint256(0), 1], [uint256(1), 2], [uint256(2), 4], [uint256(3), 6], [uint256(2), 5], [uint256(4), 3]];
        for (uint256 i; i < invalid.length; ++i) {
            vm.prank(buyer);
            vm.expectRevert("Invalid consensus threshold");
            ob.submitJob{value: PRICE}(PRICE, invalid[i][0], invalid[i][1], EXEC, "img");
        }
        uint256[2][6] memory valid = [[uint256(1), 1], [uint256(2), 2], [uint256(2), 3], [uint256(3), 4], [uint256(3), 5], [uint256(4), 6]];
        for (uint256 i; i < valid.length; ++i) _submit(PRICE, valid[i][0], valid[i][1]);
    }

    function testFuzz_SubmitAcceptsExactlyTheMajorityThresholds(uint256 k, uint256 quorum) public {
        k = bound(k, 0, 300);
        quorum = bound(quorum, 0, 300);
        vm.prank(buyer);
        if (2 * k > quorum && k <= quorum) {
            ob.submitJob{value: PRICE}(PRICE, k, quorum, EXEC, "img");
        } else {
            vm.expectRevert("Invalid consensus threshold");
            ob.submitJob{value: PRICE}(PRICE, k, quorum, EXEC, "img");
        }
    }

    // With the majority rule a 2-2 split can't be a consensus: 4 providers need 3 matches, so the
    // split ends in NO_QUORUM and everyone, both pairs included, gets their money back.
    function test_AnEvenSplitIsNoQuorumAndRefundsEveryone() public {
        address[] memory ps = _first(4);
        JobID_t id = _runToRevealEnd(PRICE, 3, ps, _outputs("a", "a", "b", "b"));
        uint256 stake = _required(id, ps[0]);
        _settle(id);
        assertEq(_status(id), NO_QUORUM);
        assertEq(ob.credits(buyer), PRICE);
        for (uint256 i; i < 4; ++i) assertEq(ob.credits(ps[i]), stake, "no pair is slashed");
        assertEq(address(ob).balance, _owed());
    }

    function test_NoRevealsAtAllIsNoQuorumWithEverythingRefunded() public {
        address[] memory ps = _first(3);
        JobID_t id = _runToRevealEnd(PRICE, 2, ps, _outputs("hide", "hide", ""));
        uint256 stake = _required(id, ps[0]);
        _settle(id);
        assertEq(_status(id), NO_QUORUM);
        assertEq(ob.credits(buyer), PRICE);
        for (uint256 i; i < 3; ++i) assertEq(ob.credits(ps[i]), stake);
        assertEq(address(ob).balance, _owed());
    }

    // ───────────── stake curve and reputation ─────────────

    function test_StakeCurveAtKeyReputations() public {
        address p = provs[0];
        uint16[6] memory reps = [uint16(0), 500, 999, 1000, 2000, 65535];
        // STAKE * (1 + 5 * 2^(-rep/1000)), interpolated linearly within each half-life
        uint256[6] memory expected = [
            6 * S,                                      // 0: six times the base
            S + 5 * S - (5 * S * 500) / 2000,           // 500: 4.75x
            S + 5 * S - (5 * S * 999) / 2000,           // 999: just above 3.5x
            S + (5 * S) / 2,                            // 1000: 3.5x
            S + (5 * S) / 4,                            // 2000: 2.25x
            S                                           // max: the base stake
        ];
        for (uint256 i; i < reps.length; ++i) {
            _setReputation(p, reps[i]);
            assertEq(ob.stakeFor(p), expected[i]);
        }
    }

    function testFuzz_StakeNeverRisesWithReputation(uint16 a, uint16 b) public {
        vm.assume(a <= b);
        _setReputation(provs[0], a);
        _setReputation(provs[1], b);
        uint256 lower = ob.stakeFor(provs[0]);
        uint256 higher = ob.stakeFor(provs[1]);
        assertGe(lower, higher, "more reputation never costs more stake");
        assertLe(lower, 6 * S);
        assertGe(higher, S);
    }

    function test_ReputationNeverGoesBelowZero() public {
        address[] memory ps = _first(3);
        JobID_t id = _runToRevealEnd(PRICE, 2, ps, _outputs("a", "a", "wrong"));
        _settle(id);
        assertEq(ob.reputationOf(ps[2]), 0, "a slash at 0 stays at 0");
        assertEq(ob.stakeFor(ps[2]), 6 * S);
    }

    function test_ReputationStopsAtItsMaximum() public {
        address[] memory ps = _first(2);
        _setReputation(ps[0], type(uint16).max);
        JobID_t id = _runToRevealEnd(PRICE, 2, ps, _outputs2("a", "a"));
        _settle(id);
        assertEq(ob.reputationOf(ps[0]), type(uint16).max, "a win at the maximum doesn't overflow");
        assertEq(ob.reputationOf(ps[1]), 1);
    }

    // ───────────── session keys mid-job ─────────────

    function _registerSession(address owner, uint256 sessionKey, uint64 expiresAt) internal {
        address session = vm.addr(sessionKey);
        bytes32 digest = ob.sessionKeyDigest(owner, session, expiresAt);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sessionKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        vm.prank(owner);
        ob.registerSessionKey(session, expiresAt, abi.encodePacked(r, s, v));
    }

    function test_SessionKeyExpiringMidJobLocksOutTheKeyButNotTheOwner() public {
        address owner = provs[0];
        uint256 sessionKey = 0xBEEF;
        address session = vm.addr(sessionKey);
        vm.deal(session, 10 ether);
        _registerSession(owner, sessionKey, uint64(block.timestamp + 40));

        JobID_t id = _submit(PRICE, 2, 2);
        ob.assignProviders(id, _first(2));
        uint256 r = _required(id, owner);
        vm.prank(session);
        ob.submitStake{value: r}(id); // the key stakes for the owner
        _stake(id, provs[1]);
        ob.finalizeProviderSelection(id);
        vm.prank(session);
        ob.submitCommitment(id, _commitment("out", _salt(owner)));
        _commit(id, provs[1], "out");
        vm.warp(block.timestamp + EXEC + 1); // the key has expired by now
        ob.startRevealPhase(id);

        vm.prank(session);
        vm.expectRevert("Provider not assigned");
        ob.submitReveal(id, "out", _salt(owner));

        _reveal(id, owner, "out"); // the owner's own wallet can still finish the job
        _reveal(id, provs[1], "out");
        vm.warp(block.timestamp + ob.REVEAL_WINDOW() + 1);
        _settle(id);
        assertGt(ob.credits(owner), 0, "the owner is paid");
        assertEq(ob.credits(session), 0, "the key never holds funds");
    }

    function test_RevokingASessionKeyMidJobStopsItImmediately() public {
        address owner = provs[0];
        uint256 sessionKey = 0xCAFE;
        address session = vm.addr(sessionKey);
        vm.deal(session, 10 ether);
        _registerSession(owner, sessionKey, uint64(block.timestamp + 1 days));
        JobID_t id = _submit(PRICE, 2, 2);
        ob.assignProviders(id, _first(2));
        uint256 r = _required(id, owner);
        vm.prank(session);
        ob.submitStake{value: r}(id);
        _stake(id, provs[1]);
        ob.finalizeProviderSelection(id);

        vm.prank(owner);
        ob.revokeSessionKey();
        vm.prank(session);
        vm.expectRevert("Provider not assigned");
        ob.submitCommitment(id, _commitment("out", _salt(owner)));
        assertEq(_staked(id, owner), r, "the stake stays the owner's");
    }

    function test_RegisteringAKeyThatRejectsTheFundingRevertsEverything() public {
        address owner = provs[0];
        uint256 sessionKey = 0xD00D;
        address session = vm.addr(sessionKey);
        vm.etch(session, hex"60006000fd"); // code that always reverts: PUSH1 0 PUSH1 0 REVERT
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32 digest = ob.sessionKeyDigest(owner, session, expiresAt);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sessionKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        vm.prank(owner);
        vm.expectRevert("Funding transfer failed");
        ob.registerSessionKey{value: 1 ether}(session, expiresAt, abi.encodePacked(r, s, v));
        assertEq(ob.activeSessionKey(owner), address(0), "nothing was registered");
        assertEq(ob.providerOf(session), session);
    }

    // Some signers produce v as 0/1 instead of 27/28; registration accepts both forms.
    function test_SessionKeySignatureWithVAsZeroOrOneIsAccepted() public {
        address owner = provs[0];
        uint256 sessionKey = 0xF00D;
        address session = vm.addr(sessionKey);
        uint64 expiresAt = uint64(block.timestamp + 1 days);
        bytes32 digest = ob.sessionKeyDigest(owner, session, expiresAt);
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(sessionKey, keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", digest)));
        vm.prank(owner);
        ob.registerSessionKey(session, expiresAt, abi.encodePacked(r, s, v - 27));
        assertEq(ob.providerOf(session), owner);
    }

    // ───────────── cancellation ─────────────

    function test_OnlyTheBuyerCancelsAndOnlyBeforeTheProviderSetIsFinal() public {
        JobID_t id = _submit(PRICE, 2, 2);
        vm.prank(provs[0]);
        vm.expectRevert("Only buyer");
        ob.cancelJob(id);

        ob.assignProviders(id, _first(2));
        _stake(id, provs[0]);
        _stake(id, provs[1]);
        ob.finalizeProviderSelection(id);
        vm.prank(buyer);
        vm.expectRevert("Job no longer pending");
        ob.cancelJob(id);

        vm.prank(buyer);
        vm.expectRevert("Unknown job");
        ob.cancelJob(JobID_t.wrap(999));
    }

    function test_ACanceledJobCantBeAssignedOrStakedOn() public {
        JobID_t id = _submit(PRICE, 2, 2);
        vm.prank(buyer);
        ob.cancelJob(id);
        vm.expectRevert("Job not awaiting assignment");
        ob.assignProviders(id, _first(2));
        vm.prank(provs[0]);
        vm.expectRevert("Not in staking phase");
        ob.submitStake{value: S}(id);
    }

    // ───────────── withdraw ─────────────

    function test_WithdrawCantBeReentered() public {
        ReentrantBuyer attackerBuyer = new ReentrantBuyer(ob);
        vm.deal(address(attackerBuyer), PRICE);
        JobID_t id = attackerBuyer.submit(PRICE);
        attackerBuyer.cancel(id);
        assertEq(ob.credits(address(attackerBuyer)), PRICE);

        attackerBuyer.withdraw();
        assertEq(address(attackerBuyer).balance, PRICE, "paid exactly once");
        assertTrue(attackerBuyer.reentryFailed(), "the nested withdraw was refused");
        assertEq(ob.credits(address(attackerBuyer)), 0);
    }

    function test_WithdrawPaysTheCallerOnly() public {
        JobID_t id = _submit(PRICE, 2, 2);
        vm.prank(buyer);
        ob.cancelJob(id);
        vm.prank(provs[0]);
        vm.expectRevert("No credit");
        ob.withdraw();
        assertEq(ob.credits(buyer), PRICE);
    }

    // ───────────── helpers ─────────────

    function _outputs1(bytes memory a) internal pure returns (bytes[] memory o) {
        o = new bytes[](1);
        o[0] = a;
    }

    function _outputs2(bytes memory a, bytes memory b) internal pure returns (bytes[] memory o) {
        o = new bytes[](2);
        (o[0], o[1]) = (a, b);
    }
}

// A buyer contract whose receive() tries to withdraw again.
contract ReentrantBuyer {
    OffBalance ob;
    bool public reentryFailed;
    bool entered;

    constructor(OffBalance _ob) {
        ob = _ob;
    }

    function submit(uint256 price) external returns (JobID_t) {
        return ob.submitJob{value: price}(price, 1, 1, 60, "img");
    }

    function cancel(JobID_t id) external {
        ob.cancelJob(id);
    }

    function withdraw() external {
        ob.withdraw();
    }

    receive() external payable {
        if (entered) return;
        entered = true;
        try ob.withdraw() {} catch {
            reentryFailed = true;
        }
    }
}
