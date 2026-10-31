// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {OffBalance, JobID_t} from "./OffBalance.sol";

contract OffBalancePricingTest is Test {
    OffBalance market;
    JobID_t constant JOB = JobID_t.wrap(1);
    address constant BUYER = address(0x100);
    uint256 constant STAKE = 0.0001 ether;
    string constant IMAGE = "repo@sha256:abc";

    function setUp() public {
        market = new OffBalance();
        vm.deal(BUYER, 1 ether);
        for (uint256 i; i < 3; ++i) vm.deal(address(uint160(i + 0x200)), 1 ether);
    }

    function testFuzz_QuoteExactCeiling(uint128 rate, uint64 secondsBooked) public view {
        vm.assume(rate > 0 && secondsBooked > 0);
        uint256 product = uint256(rate) * secondsBooked;
        assertEq(market.quoteProvider(rate, secondsBooked), product / 3600 + (product % 3600 == 0 ? 0 : 1));
    }

    function test_QuoteWideProductsAndOverflowBounds() public {
        assertEq(market.quoteProvider(type(uint256).max, 3600), type(uint256).max);
        assertEq(market.quoteProvider(3600, type(uint256).max), type(uint256).max);
        assertEq(market.quoteProvider(type(uint256).max, 1), type(uint256).max / 3600 + 1);
        assertEq(market.quoteEscrow(1, 1, 3), 3); // round per provider before summing
        vm.expectRevert();
        market.quoteProvider(type(uint256).max, 3601);
        vm.expectRevert();
        market.quoteEscrow(type(uint256).max, 3600, 2);
    }

    function test_SubmissionExactEscrowAndTerms() public {
        vm.expectRevert("Send exact job escrow");
        vm.prank(BUYER);
        market.submitJob{value: 50}(JOB, 1001, 3, 2, 61, IMAGE);
        vm.expectRevert("Send exact job escrow");
        vm.prank(BUYER);
        market.submitJob{value: 52}(JOB, 1001, 3, 2, 61, IMAGE);
        _submit();
        (address creator, uint256 rate, uint256 k, uint256 quorum, uint256 secondsBooked, string memory image, uint256 escrow) = market.getJobTerms(JOB);
        assertEq(creator, BUYER);
        assertEq(rate, 1001);
        assertEq(k, 3);
        assertEq(quorum, 2);
        assertEq(secondsBooked, 61);
        assertEq(image, IMAGE);
        assertEq(escrow, 51);
    }

    function test_RejectZeroAndOutOfCapRatesOrMismatchedArrays() public {
        _submit();
        address[] memory providers = _providers();
        uint256[] memory rates = _rates();
        rates[0] = 0;
        vm.expectRevert("Provider rate outside cap");
        market.assignProviders(JOB, providers, rates);
        rates[0] = 1002;
        vm.expectRevert("Provider rate outside cap");
        market.assignProviders(JOB, providers, rates);
        vm.expectRevert("Provider rates length mismatch");
        market.assignProviders(JOB, providers, new uint256[](2));
        assertEq(market.getAssignedProviders(JOB).length, 0);
        market.assignProviders(JOB, providers, _rates());
        vm.expectRevert("Job not awaiting assignment");
        market.assignProviders(JOB, providers, _rates());
    }

    function test_DifferentRatesEarnOnlyOwnBookedChargesAndRefundCapSavings() public {
        vm.recordLogs();
        _run(true, 7, 7);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _totals(logs, 28, 23, 0);
        _credits(23, STAKE + 2, STAKE + 9, STAKE + 17, 0);
        assertEq(_amount(logs, "PAID(uint256,address,uint256)", address(0x200)), 2);
        assertEq(_amount(logs, "PAID(uint256,address,uint256)", address(0x201)), 9);
        assertEq(_amount(logs, "PAID(uint256,address,uint256)", address(0x202)), 17);
        assertEq(_amount(logs, "STAKE_RETURNED(uint256,address,uint256)", address(0x200)), STAKE);
    }

    function test_FailedDeliveryRefundsWorkAndSeparatesSlashReward() public {
        vm.recordLogs();
        _run(true, 7, 3);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        _totals(logs, 11, 40, STAKE);
        _credits(40, STAKE + 2 + STAKE / 2, STAKE + 9 + STAKE / 2, 0, 0);
        assertEq(_amount(logs, "PAID(uint256,address,uint256)", address(0x200)), 2);
        assertEq(_amount(logs, "SLASH_REWARD(uint256,address,uint256)", address(0x200)), STAKE / 2);
        assertEq(_amount(logs, "SLASHED(uint256,address,uint256)", address(0x202)), STAKE);
    }

    function test_NoQuorumPaysRevealersOwnRatesWithoutDelivery() public {
        vm.recordLogs();
        _run(false, 3, 0); // third provider committed but never revealed
        _totals(vm.getRecordedLogs(), 11, 40, STAKE);
        _credits(40, STAKE + 2 + STAKE / 2, STAKE + 9 + STAKE / 2, 0, 0);
        assertEq(uint256(market.getJobStatus(JOB)), uint256(OffBalance.Status.NO_QUORUM));
    }

    function test_NoWinnersRefundFullEscrowAndRetainSlashedStakes() public {
        vm.recordLogs();
        _run(true, 7, 0);
        _totals(vm.getRecordedLogs(), 0, 51, 3 * STAKE);
        _credits(51, 0, 0, 0, 3 * STAKE);
    }

    function test_CancelRefundsOnceAndEmitsZeroWorkTotals() public {
        _submit();
        vm.recordLogs();
        vm.prank(BUYER);
        market.cancelJob(JOB);
        _totals(vm.getRecordedLogs(), 0, 51, 0);
        assertEq(market.credits(BUYER), 51);
        vm.expectRevert("Job no longer pending");
        vm.prank(BUYER);
        market.cancelJob(JOB);
    }

    function test_WithdrawConservesEscrowAndStakeWithoutDoublePayment() public {
        _run(true, 7, 3);
        address[] memory providers = _providers();
        vm.prank(BUYER);
        market.withdraw();
        for (uint256 i; i < 2; ++i) {
            uint256 owed = market.credits(providers[i]);
            uint256 beforeBalance = providers[i].balance;
            vm.prank(providers[i]);
            market.withdraw();
            assertEq(providers[i].balance - beforeBalance, owed);
            vm.expectRevert("No credit");
            vm.prank(providers[i]);
            market.withdraw();
        }
        assertEq(address(market).balance, 0);
    }

    function _submit() private {
        vm.prank(BUYER);
        market.submitJob{value: 51}(JOB, 1001, 3, 2, 61, IMAGE);
    }

    function _providers() private pure returns (address[] memory result) {
        result = new address[](3);
        for (uint256 i; i < 3; ++i) result[i] = address(uint160(i + 0x200));
    }

    function _rates() private pure returns (uint256[] memory result) {
        result = new uint256[](3);
        result[0] = 101;
        result[1] = 509;
        result[2] = 1001;
    }

    function _run(bool consensus, uint256 revealedMask, uint256 deliveredMask) private {
        _submit();
        address[] memory providers = _providers();
        market.assignProviders(JOB, providers, _rates());
        for (uint256 i; i < 3; ++i) {
            bytes memory output = consensus ? bytes("same") : abi.encode(i);
            vm.prank(providers[i]);
            market.submitCommitment{value: STAKE}(JOB, keccak256(abi.encode(keccak256(output), bytes32(i))));
        }
        vm.warp(block.timestamp + 62);
        market.startRevealPhase(JOB);
        for (uint256 i; i < 3; ++i) {
            if (revealedMask & (1 << i) == 0) continue;
            bytes memory output = consensus ? bytes("same") : abi.encode(i);
            vm.prank(providers[i]);
            market.submitReveal(JOB, output, bytes32(i));
        }
        vm.warp(block.timestamp + market.REVEAL_WINDOW() + 1);
        market.endRevealPhase(JOB);
        if (market.getJobStatus(JOB) != OffBalance.Status.DELIVERING) return;
        for (uint256 i; i < 3; ++i) {
            if (deliveredMask & (1 << i) != 0) market.verifyReceipt(JOB, providers[i]);
        }
        vm.warp(block.timestamp + market.DELIVERY_WINDOW() + 1);
        market.endDeliveryPhase(JOB);
    }

    function _totals(Vm.Log[] memory logs, uint256 work, uint256 refund, uint256 slash) private pure {
        bytes32 signature = keccak256("JOB_SETTLED(uint256,address,uint256,uint256,uint256,uint256)");
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != signature) continue;
            (uint256 escrow, uint256 paid, uint256 refunded, uint256 slashed) = abi.decode(logs[i].data, (uint256, uint256, uint256, uint256));
            assertEq(escrow, 51);
            assertEq(paid, work);
            assertEq(refunded, refund);
            assertEq(slashed, slash);
            return;
        }
        revert("Missing settlement event");
    }

    function _credits(uint256 buyer, uint256 a, uint256 b, uint256 c, uint256 retained) private view {
        assertEq(market.credits(BUYER), buyer);
        assertEq(market.credits(address(0x200)), a);
        assertEq(market.credits(address(0x201)), b);
        assertEq(market.credits(address(0x202)), c);
        assertEq(address(market).balance, buyer + a + b + c + retained);
    }

    function _amount(Vm.Log[] memory logs, string memory signature, address provider) private pure returns (uint256) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == keccak256(bytes(signature)) && logs[i].topics[2] == bytes32(uint256(uint160(provider)))) {
                return abi.decode(logs[i].data, (uint256));
            }
        }
        return 0;
    }
}
