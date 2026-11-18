// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {JobID_t} from "../contracts/OffBalance.sol";
import {OffBalanceFixture} from "./OffBalanceFixture.sol";

// Fuzz tests on the contract's money and reputation.
//
// testFuzz_RandomActionsConserveMoney: STEPS random actions across a few jobs (submit, assign,
// stake, finalize, commit, reveal, phase transitions, cancel, withdraw, time passing), many of
// which revert (wrong phase, wrong caller, too early, wrong stake). After every step:
//   - the contract holds exactly what it owes (credits + locked stake + escrow of unfinished jobs), and
//   - everything that came in (escrow + stakes) minus everything withdrawn is still there.
// At the end, no finished job still holds a stake. Random order rarely finishes a job, so this
// mostly covers cancellation, refunds and out-of-order calls.
//
// testFuzz_LifecycleMatchesExpectedPayouts: jobs driven through every phase in order, with random
// prices, provider counts, thresholds, cancellations and per-provider behaviour. Each job's
// outcome (who is paid how much, who is refunded or slashed, reputation changes) is worked out
// independently here and compared with what the contract did.
contract OffBalanceFuzzTest is OffBalanceFixture {
    uint256 constant STEPS = 80;

    JobID_t[] jobs;
    mapping(uint256 => mapping(address => bytes)) committed; // job -> provider -> output
    uint256 deposited;
    uint256 withdrawn;
    bytes32 rand;

    function _next() internal returns (uint256) {
        rand = keccak256(abi.encode(rand));
        return uint256(rand);
    }

    function _pickJob() internal returns (bool ok, JobID_t id) {
        if (jobs.length == 0) return (false, id);
        return (true, jobs[_next() % jobs.length]);
    }

    function testFuzz_RandomActionsConserveMoney(uint256 seed) public {
        rand = bytes32(seed);
        for (uint256 step; step < STEPS; ++step) {
            _act(_next());
            assertEq(address(ob).balance, _owed() + _openEscrow(), "balance != credits + locked stake + open escrow");
            assertEq(address(ob).balance, deposited - withdrawn, "money appeared or disappeared");
        }
        for (uint256 j; j < jobs.length; ++j) {
            uint8 s = _status(jobs[j]);
            if (s != PAID && s != CANCELED && s != NO_QUORUM) continue;
            for (uint256 p; p < provs.length; ++p) assertEq(_staked(jobs[j], provs[p]), 0, "finished job still holds a stake");
        }
    }

    // Weighted so jobs get finished: few open jobs at a time, rare cancellations, short time steps.
    function _act(uint256 roll) internal {
        roll %= 100;
        if (roll < 8) return _actSubmit();
        if (roll < 22) return _actAssign();
        if (roll < 36) return _actStake();
        if (roll < 50) return _actCommit();
        if (roll < 64) return _actReveal();
        if (roll < 80) return _actTransition();
        if (roll < 82) return _actCancel();
        if (roll < 88) return _actWithdraw();
        vm.warp(block.timestamp + _next() % 25); // time passes; windows are 10-30, 15 and 30 s
    }

    function _actSubmit() internal {
        if (_openJobs() >= 3) return;
        uint256 price = 1 + _next() % 3 ether;
        uint256 quorum = 1 + _next() % 4;
        uint256 k = 1 + _next() % quorum;
        vm.prank(buyer);
        try ob.submitJob{value: price}(price, k, quorum, 10 + _next() % 21, "img") returns (JobID_t id) {
            jobs.push(id);
            quorumOf[JobID_t.unwrap(id)] = quorum;
            priceOf[JobID_t.unwrap(id)] = price;
            deposited += price;
        } catch {}
    }

    function _actAssign() internal {
        (bool ok, JobID_t id) = _pickJob();
        if (!ok) return;
        uint256 n = ob.getAssignedProviders(id).length == 0 ? _quorum(id) : 0;
        if (n == 0) return;
        address[] memory ps = new address[](n);
        uint256 start = _next() % provs.length;
        for (uint256 i; i < n; ++i) ps[i] = provs[(start + i) % provs.length];
        try ob.assignProviders(id, ps) {} catch {}
    }

    // Each provider action covers every provider assigned to a job, each one skipping now and
    // then, so random runs regularly get jobs all the way to consensus and payout.
    function _actStake() internal {
        (bool ok, JobID_t id) = _pickJob();
        if (!ok) return;
        address[] memory ps = ob.getAssignedProviders(id);
        for (uint256 i; i < ps.length; ++i) {
            if (_next() % 8 == 0) continue; // a provider that doesn't stake
            uint256 value = _required(id, ps[i]);
            if (_next() % 16 == 0) value += 1; // or stakes the wrong amount
            vm.prank(ps[i]);
            try ob.submitStake{value: value}(id) {
                deposited += value;
            } catch {}
        }
    }

    function _actCommit() internal {
        (bool ok, JobID_t id) = _pickJob();
        if (!ok) return;
        address[] memory ps = ob.getAssignedProviders(id);
        for (uint256 i; i < ps.length; ++i) {
            if (_next() % 8 == 0) continue; // never commits
            bytes memory output = _next() % 4 == 0 ? bytes("b") : bytes("a"); // mostly agreeing
            vm.prank(ps[i]);
            try ob.submitCommitment(id, _commitment(output, _salt(ps[i]))) {
                committed[JobID_t.unwrap(id)][ps[i]] = output;
            } catch {}
        }
    }

    function _actReveal() internal {
        (bool ok, JobID_t id) = _pickJob();
        if (!ok) return;
        address[] memory ps = ob.getAssignedProviders(id);
        for (uint256 i; i < ps.length; ++i) {
            if (_next() % 8 == 0) continue; // commits but never reveals
            bytes memory output = committed[JobID_t.unwrap(id)][ps[i]];
            if (output.length == 0) output = "a"; // nothing committed: this reveal must fail
            vm.prank(ps[i]);
            try ob.submitReveal(id, output, _salt(ps[i])) {} catch {}
        }
    }

    function _actTransition() internal {
        (bool ok, JobID_t id) = _pickJob();
        if (!ok) return;
        address anyone = makeAddr("anyone");
        vm.startPrank(anyone);
        try ob.finalizeProviderSelection(id) {} catch {}
        try ob.startRevealPhase(id) {} catch {}
        try ob.endRevealPhase(id) {} catch {}
        try ob.endDeliveryPhase(id) {} catch {}
        vm.stopPrank();
    }

    function _actCancel() internal {
        (bool ok, JobID_t id) = _pickJob();
        if (!ok) return;
        vm.prank(buyer);
        try ob.cancelJob(id) {} catch {}
    }

    function _actWithdraw() internal {
        address[] memory e = _everyone();
        address who = e[_next() % e.length];
        uint256 owed = ob.credits(who);
        uint256 before = who.balance;
        vm.prank(who);
        try ob.withdraw() {
            withdrawn += owed;
            assertEq(who.balance - before, owed, "withdraw paid a different amount than the credit");
        } catch {
            assertEq(owed, 0, "withdraw failed with credit outstanding");
        }
    }

    // the contract doesn't expose a job's quorum, so remember what each job was submitted with
    function _quorum(JobID_t id) internal view returns (uint256) {
        return quorumOf[JobID_t.unwrap(id)];
    }

    mapping(uint256 => uint256) quorumOf;
    mapping(uint256 => uint256) priceOf;

    function _openJobs() internal view returns (uint256 open) {
        for (uint256 j; j < jobs.length; ++j) {
            uint8 s = _status(jobs[j]);
            if (s != PAID && s != CANCELED && s != NO_QUORUM) ++open;
        }
    }

    // a job's price stays in escrow until it's paid out, refunded or canceled
    function _openEscrow() internal view returns (uint256 escrow) {
        for (uint256 j; j < jobs.length; ++j) {
            uint8 s = _status(jobs[j]);
            if (s != PAID && s != CANCELED && s != NO_QUORUM) escrow += priceOf[JobID_t.unwrap(jobs[j])];
        }
    }

    // ───────────── lifecycle fuzz with expected outcomes ─────────────

    enum Behaviour { Agree, Disagree, NoStake, NoCommit, NoReveal }

    struct Before {
        uint256 buyer;
        uint256[6] credits;
        uint16[6] reputation;
    }

    // the job _lifecycle is driving (kept in storage: too many values for the stack)
    JobID_t cur;
    uint256 curPrice;
    uint256 curK;
    address[] curPs;
    Behaviour[] curHow;
    uint256[] curStake;
    Before curBefore;

    function testFuzz_LifecycleMatchesExpectedPayouts(uint256 seed) public {
        rand = bytes32(seed);
        for (uint256 round; round < 4; ++round) _lifecycle();
        assertEq(address(ob).balance, _owed(), "after every job finished, only credits remain");
    }

    function _lifecycle() internal {
        _lcSubmitAndStake();
        // sometimes the buyer cancels during staking: escrow and every stake come back
        if (_next() % 8 == 0) {
            vm.prank(buyer);
            ob.cancelJob(cur);
            assertEq(ob.credits(buyer), curBefore.buyer + curPrice, "cancel refunds the buyer");
            for (uint256 i; i < curPs.length; ++i) _expectCredit(curPs[i], curStake[i], "cancel refunds stakes");
            return _expectReputationUnchanged();
        }
        vm.warp(block.timestamp + ob.PENDING_WINDOW() + 1);
        ob.finalizeProviderSelection(cur);
        uint256 stakers;
        for (uint256 i; i < curPs.length; ++i) if (curHow[i] != Behaviour.NoStake) ++stakers;
        if (stakers < curK) {
            assertEq(_status(cur), NO_QUORUM, "too few stakers ends the job");
            return _expectRefunds();
        }
        _lcCommitAndReveal();
        (bytes memory best, uint256 bestCount) = _expectedTally(ob.getAssignedProviders(cur));
        _settle(cur);
        if (bestCount < curK) {
            assertEq(_status(cur), NO_QUORUM, "no consensus ends the job");
            return _expectRefunds();
        }
        assertEq(_status(cur), PAID);
        _expectPayouts(best);
    }

    function _lcSubmitAndStake() internal {
        curPrice = 1 + _next() % 3 ether;
        uint256 quorum = 1 + _next() % 4;
        curK = 1 + _next() % quorum;
        delete curPs;
        delete curHow;
        delete curStake;
        uint256 start = _next() % provs.length;
        for (uint256 i; i < quorum; ++i) curPs.push(provs[(start + i) % provs.length]);
        curBefore = _snapshot();
        cur = _submit(curPrice, curK, quorum);
        ob.assignProviders(cur, curPs);
        for (uint256 i; i < quorum; ++i) {
            uint256 r = _next() % 10; // mostly agreeing, sometimes each kind of failure
            curHow.push(r < 5 ? Behaviour.Agree : r < 7 ? Behaviour.Disagree : r == 7 ? Behaviour.NoStake
                : r == 8 ? Behaviour.NoCommit : Behaviour.NoReveal);
            curStake.push(curHow[i] == Behaviour.NoStake ? 0 : _required(cur, curPs[i]));
            if (curHow[i] != Behaviour.NoStake) _stake(cur, curPs[i]);
        }
    }

    function _lcCommitAndReveal() internal {
        for (uint256 i; i < curPs.length; ++i) {
            if (curHow[i] == Behaviour.NoStake || curHow[i] == Behaviour.NoCommit) continue;
            _commit(cur, curPs[i], curHow[i] == Behaviour.Disagree ? bytes("b") : bytes("a"));
        }
        vm.warp(block.timestamp + EXEC + 1);
        ob.startRevealPhase(cur);
        for (uint256 i; i < curPs.length; ++i) {
            if (curHow[i] == Behaviour.Agree) _reveal(cur, curPs[i], "a");
            else if (curHow[i] == Behaviour.Disagree) _reveal(cur, curPs[i], "b");
        }
        vm.warp(block.timestamp + ob.REVEAL_WINDOW() + 1);
    }

    // winners revealed the best answer; everyone else who staked is slashed into the pool
    function _expectPayouts(bytes memory best) internal view {
        uint256 pool = curPrice;
        uint256 winners;
        for (uint256 i; i < curPs.length; ++i) {
            if (_revealed(curHow[i], best)) ++winners;
            else pool += curStake[i];
        }
        uint256 share = pool / winners;
        uint256 dust = pool - share * winners;
        uint256 paid;
        for (uint256 i; i < curPs.length; ++i) {
            uint256 idx = _index(curPs[i]);
            uint256 got = ob.credits(curPs[i]) - curBefore.credits[idx];
            uint16 was = curBefore.reputation[idx];
            if (_revealed(curHow[i], best)) {
                assertTrue(got == share + curStake[i] || got == share + dust + curStake[i], "winner gets a share plus its stake");
                paid += got - curStake[i];
                assertEq(ob.reputationOf(curPs[i]), _plusOne(was), "winner gains reputation");
            } else {
                assertEq(got, 0, "a provider not on the winning answer gets nothing");
                if (curHow[i] != Behaviour.NoStake) {
                    assertEq(ob.reputationOf(curPs[i]), was == 0 ? 0 : was - 1, "a slashed provider loses reputation");
                }
            }
        }
        assertEq(paid, pool, "winners share exactly the price plus the slashed stakes");
        assertEq(ob.credits(buyer), curBefore.buyer, "the buyer isn't refunded on success");
    }

    function _expectedTally(address[] memory kept) internal view returns (bytes memory best, uint256 bestCount) {
        // same rule as OffBalance._tally: first answer (in `kept` order) with the strictly highest count
        bytes[] memory answers = new bytes[](kept.length);
        uint256 n;
        for (uint256 i; i < kept.length; ++i) {
            for (uint256 j; j < curPs.length; ++j) {
                if (curPs[j] != kept[i]) continue;
                if (curHow[j] == Behaviour.Agree) answers[n++] = "a";
                else if (curHow[j] == Behaviour.Disagree) answers[n++] = "b";
            }
        }
        for (uint256 i; i < n; ++i) {
            uint256 count = 1;
            for (uint256 j = i + 1; j < n; ++j) if (keccak256(answers[j]) == keccak256(answers[i])) ++count;
            if (count > bestCount) (bestCount, best) = (count, answers[i]);
        }
    }

    function _revealed(Behaviour how, bytes memory best) internal pure returns (bool) {
        bytes memory answer = how == Behaviour.Agree ? bytes("a") : how == Behaviour.Disagree ? bytes("b") : bytes("");
        return answer.length > 0 && keccak256(answer) == keccak256(best);
    }

    function _expectRefunds() internal view {
        assertEq(ob.credits(buyer), curBefore.buyer + curPrice, "no quorum refunds the buyer");
        for (uint256 i; i < curPs.length; ++i) {
            _expectCredit(curPs[i], curStake[i], "no quorum refunds every stake");
            assertEq(_staked(cur, curPs[i]), 0);
        }
        _expectReputationUnchanged();
    }

    function _expectCredit(address p, uint256 amount, string memory why) internal view {
        assertEq(ob.credits(p), curBefore.credits[_index(p)] + amount, why);
    }

    function _expectReputationUnchanged() internal view {
        for (uint256 i; i < curPs.length; ++i) {
            assertEq(ob.reputationOf(curPs[i]), curBefore.reputation[_index(curPs[i])], "refunds don't change reputation");
        }
    }

    function _snapshot() internal view returns (Before memory b) {
        b.buyer = ob.credits(buyer);
        for (uint256 i; i < provs.length; ++i) {
            b.credits[i] = ob.credits(provs[i]);
            b.reputation[i] = ob.reputationOf(provs[i]);
        }
    }

    function _index(address p) internal view returns (uint256) {
        for (uint256 i; i < provs.length; ++i) if (provs[i] == p) return i;
        revert("unknown provider");
    }

    function _plusOne(uint16 r) internal pure returns (uint16) {
        return r == type(uint16).max ? r : r + 1;
    }
}
