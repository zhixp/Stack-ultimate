// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {StackUltimate} from "../src/StackUltimate.sol";

/// Usage (Base Sepolia):
///   OPERATOR_ADDRESS=0x... forge script script/Deploy.s.sol \
///     --rpc-url base_sepolia --account deployer --broadcast
/// Optional env: TICKET_PRICE_WEI, DEV_FEE_BPS, WINNER_BPS, ROUND_SECONDS
contract Deploy is Script {
    function run() external returns (StackUltimate game) {
        address operator = vm.envAddress("OPERATOR_ADDRESS");
        uint256 price = vm.envOr("TICKET_PRICE_WEI", uint256(0.0001 ether));
        uint16 devFee = uint16(vm.envOr("DEV_FEE_BPS", uint256(1_000)));
        uint16 winner = uint16(vm.envOr("WINNER_BPS", uint256(8_000)));
        uint64 round = uint64(vm.envOr("ROUND_SECONDS", uint256(1 days)));

        vm.startBroadcast();
        game = new StackUltimate(operator, price, devFee, winner, round);
        vm.stopBroadcast();

        console.log("StackUltimate deployed at", address(game));
    }
}
