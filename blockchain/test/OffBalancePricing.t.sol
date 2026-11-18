// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {OffBalanceFixture, JobID_t} from "./OffBalanceFixture.sol";

contract OffBalancePricingTest is OffBalanceFixture {
    bytes32 constant QUOTE = bytes32(uint256(1));
    uint256 constant CAP = 3601; // 61 wei per provider for the 60-second window
    uint256 constant ESCROW = 61 * 3;

    function _submitQuote() private returns (JobID_t) {
        vm.prank(buyer);
        return ob.submitQuotedJob{value: ESCROW}(QUOTE, CAP, 2, 3, EXEC, "img");
    }

    function test_QuotedJobRequiresFullEscrowAndCannotBeSubmittedTwice() public {
        vm.prank(buyer);
        vm.expectRevert("Send exact job price");
        ob.submitQuotedJob{value: ESCROW - 1}(QUOTE, CAP, 2, 3, EXEC, "img");
        JobID_t id = _submitQuote();
        assertEq(address(ob).balance, ESCROW);
        vm.prank(buyer);
        vm.expectRevert("Invalid or used quote");
        ob.submitQuotedJob{value: ESCROW}(QUOTE, CAP, 2, 3, EXEC, "img");
        vm.prank(buyer);
        ob.cancelJob(id);
        assertEq(ob.credits(buyer), ESCROW);
    }

    function test_QuotedJobPaysUnequalBookedRatesAndRefundsUnusedEscrow() public {
        JobID_t id = _submitQuote();
        address[] memory ps = _first(3);
        uint256[] memory rates = new uint256[](3);
        (rates[0], rates[1], rates[2]) = (1, 61, CAP + 1);
        vm.expectRevert("Quoted job requires rates");
        ob.assignProviders(id, ps);
        vm.expectRevert("Provider rate exceeds cap");
        ob.assignQuotedProviders(id, ps, rates);
        rates[2] = CAP;
        ob.assignQuotedProviders(id, ps, rates);
        for (uint256 i; i < ps.length; ++i) _stake(id, ps[i]);
        ob.finalizeProviderSelection(id);
        _commit(id, ps[0], "agreed");
        _commit(id, ps[1], "agreed");
        _commit(id, ps[2], "different");
        vm.warp(block.timestamp + EXEC + 1);
        ob.startRevealPhase(id);
        _reveal(id, ps[0], "agreed");
        _reveal(id, ps[1], "agreed");
        _reveal(id, ps[2], "different");
        vm.warp(block.timestamp + ob.REVEAL_WINDOW() + 1);
        uint256 stake = _staked(id, ps[2]);
        _settle(id);

        assertEq(_status(id), PAID);
        assertEq(ob.credits(buyer), ESCROW - 3);
        assertEq(ob.credits(ps[0]), 1 + stake + (stake + 1) / 2);
        assertEq(ob.credits(ps[1]), 2 + stake + stake / 2);
        assertEq(ob.credits(ps[2]), 0);
        assertEq(ob.reputationOf(ps[0]), 1);
        assertEq(address(ob).balance, _owed());
    }

    function test_QuotedJobWithoutQuorumReturnsEscrowAndStakes() public {
        JobID_t id = _submitQuote();
        address[] memory ps = _first(3);
        ob.assignQuotedProviders(id, ps, new uint256[](3));
        _stake(id, ps[0]);
        uint256 stake = _staked(id, ps[0]);
        vm.warp(block.timestamp + ob.PENDING_WINDOW() + 1);
        ob.finalizeProviderSelection(id);
        assertEq(_status(id), NO_QUORUM);
        assertEq(ob.credits(buyer), ESCROW);
        assertEq(ob.credits(ps[0]), stake);
        assertEq(address(ob).balance, _owed());
    }
}
