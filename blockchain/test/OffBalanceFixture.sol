// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {OffBalance, JobID_t} from "../contracts/OffBalance.sol";

// Shared setup for the Solidity tests in test/: accounts, a fresh contract (this test contract is
// its server), and helpers that drive a job through its phases. No test functions of its own.
abstract contract OffBalanceFixture is Test {
    OffBalance ob;

    uint256 constant PRICE = 1 ether;
    uint256 constant EXEC = 60;

    // OffBalance.Status, by index
    uint8 constant JOB_SUBMITTED = 0;
    uint8 constant PROVIDER_SELECTED = 1;
    uint8 constant COMMIT = 3;
    uint8 constant REVEAL = 4;
    uint8 constant DELIVERING = 6;
    uint8 constant PAID = 8;
    uint8 constant CANCELED = 9;
    uint8 constant NO_QUORUM = 10;

    // storage slot of the `providers` mapping in OffBalance (nextJobId 0, jobs 1, providers 2)
    uint256 constant PROVIDERS_SLOT = 2;

    address buyer = makeAddr("buyer");
    address[] provs;
    uint256[] keys;
    uint256 S; // base STAKE

    function setUp() public virtual {
        ob = new OffBalance();
        S = ob.STAKE();
        vm.deal(buyer, 1_000 ether);
        for (uint256 i = 1; i <= 6; ++i) {
            uint256 key = 0xA000 + i;
            keys.push(key);
            provs.push(vm.addr(key));
            vm.deal(vm.addr(key), 100 ether);
        }
    }

    // ───────────── job helpers ─────────────

    function _submit(uint256 price, uint256 k, uint256 quorum) internal returns (JobID_t id) {
        vm.prank(buyer);
        id = ob.submitJob{value: price}(price, k, quorum, EXEC, "img");
    }

    function _first(uint256 n) internal view returns (address[] memory ps) {
        ps = new address[](n);
        for (uint256 i; i < n; ++i) ps[i] = provs[i];
    }

    function _required(JobID_t id, address p) internal view returns (uint256 r) {
        (,,,, r,) = ob.getProviderCommitment(id, p);
    }

    function _staked(JobID_t id, address p) internal view returns (uint256 s) {
        (,,,,, s) = ob.getProviderCommitment(id, p);
    }

    function _stake(JobID_t id, address p) internal {
        uint256 r = _required(id, p);
        vm.prank(p);
        ob.submitStake{value: r}(id);
    }

    function _salt(address p) internal pure returns (bytes32) {
        return keccak256(abi.encode("salt", p));
    }

    function _commitment(bytes memory output, bytes32 salt) internal pure returns (bytes32) {
        return keccak256(abi.encode(keccak256(output), salt));
    }

    function _commit(JobID_t id, address p, bytes memory output) internal {
        vm.prank(p);
        ob.submitCommitment(id, _commitment(output, _salt(p)));
    }

    function _reveal(JobID_t id, address p, bytes memory output) internal {
        vm.prank(p);
        ob.submitReveal(id, output, _salt(p));
    }

    // Assign, stake everyone, finalize. Returns the job in COMMIT.
    function _committing(uint256 price, uint256 k, address[] memory ps) internal returns (JobID_t id) {
        id = _submit(price, k, ps.length);
        ob.assignProviders(id, ps);
        for (uint256 i; i < ps.length; ++i) _stake(id, ps[i]);
        ob.finalizeProviderSelection(id);
    }

    // Commits and reveals outputs[i] for ps[i]; "" stakes but never commits, "hide" commits but
    // never reveals. Ends just after the reveal window.
    function _runToRevealEnd(uint256 price, uint256 k, address[] memory ps, bytes[] memory outputs)
        internal
        returns (JobID_t id)
    {
        id = _committing(price, k, ps);
        for (uint256 i; i < ps.length; ++i) {
            if (outputs[i].length == 0) continue;
            _commit(id, ps[i], _isHide(outputs[i]) ? bytes("hidden") : outputs[i]);
        }
        vm.warp(block.timestamp + EXEC + 1);
        ob.startRevealPhase(id);
        for (uint256 i; i < ps.length; ++i) {
            if (outputs[i].length == 0 || _isHide(outputs[i])) continue;
            _reveal(id, ps[i], outputs[i]);
        }
        vm.warp(block.timestamp + ob.REVEAL_WINDOW() + 1);
    }

    function _isHide(bytes memory b) private pure returns (bool) {
        return keccak256(b) == keccak256("hide");
    }

    function _settle(JobID_t id) internal {
        ob.endRevealPhase(id);
        if (_status(id) != DELIVERING) return;
        vm.warp(block.timestamp + ob.DELIVERY_WINDOW() + 1);
        ob.endDeliveryPhase(id);
    }

    function _status(JobID_t id) internal view returns (uint8) {
        return uint8(ob.getJobStatus(id));
    }

    function _outputs(bytes memory a, bytes memory b, bytes memory c) internal pure returns (bytes[] memory o) {
        o = new bytes[](3);
        (o[0], o[1], o[2]) = (a, b, c);
    }

    function _outputs(bytes memory a, bytes memory b, bytes memory c, bytes memory d)
        internal
        pure
        returns (bytes[] memory o)
    {
        o = new bytes[](4);
        (o[0], o[1], o[2], o[3]) = (a, b, c, d);
    }

    function _outputs(bytes memory a, bytes memory b, bytes memory c, bytes memory d, bytes memory e)
        internal
        pure
        returns (bytes[] memory o)
    {
        o = new bytes[](5);
        (o[0], o[1], o[2], o[3], o[4]) = (a, b, c, d, e);
    }

    // ───────────── accounting ─────────────

    function _everyone() internal view returns (address[] memory e) {
        e = new address[](provs.length + 1);
        e[0] = buyer;
        for (uint256 i; i < provs.length; ++i) e[i + 1] = provs[i];
    }

    // What the contract owes: credits plus stake still locked in unsettled jobs.
    function _owed() internal view returns (uint256 owed) {
        address[] memory e = _everyone();
        for (uint256 i; i < e.length; ++i) owed += ob.credits(e[i]) + ob.lockedStake(e[i]);
    }

    // ───────────── storage access ─────────────

    // Provider.addr (20 bytes) and Provider.reputation (uint16) share the struct's first slot.
    function _setReputation(address p, uint16 rep) internal {
        bytes32 slot = keccak256(abi.encode(p, PROVIDERS_SLOT));
        uint256 word = uint256(vm.load(address(ob), slot));
        word = (word & ~(uint256(0xffff) << 160)) | (uint256(rep) << 160);
        vm.store(address(ob), slot, bytes32(word));
        require(ob.reputationOf(p) == rep, "fixture: reputation slot layout changed");
    }
}
