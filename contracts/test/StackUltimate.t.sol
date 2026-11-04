// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {StackUltimate} from "../src/StackUltimate.sol";

contract ReentrantWinner {
    StackUltimate public game;
    uint256 public reentered;

    constructor(StackUltimate game_) {
        game = game_;
    }

    function buy(uint256 count) external payable {
        game.buyTickets{value: msg.value}(count);
    }

    function claim() external {
        game.claim();
    }

    receive() external payable {
        reentered++;
        try game.claim() {} catch {}
    }
}

contract RejectingWinner {
    StackUltimate public game;

    constructor(StackUltimate game_) {
        game = game_;
    }

    function buy(uint256 count) external payable {
        game.buyTickets{value: msg.value}(count);
    }

    receive() external payable {
        revert("no");
    }
}

contract StackUltimateTest is Test {
    StackUltimate game;
    address owner = address(this);
    address op = makeAddr("operator");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");

    uint256 constant PRICE = 0.0001 ether;
    uint64 constant ROUND = 1 days;

    function setUp() public {
        game = new StackUltimate(op, PRICE, 1_000, 8_000, ROUND);
        vm.deal(alice, 10 ether);
        vm.deal(bob, 10 ether);
    }

    receive() external payable {}

    function _buy(address who, uint256 count) internal {
        vm.prank(who);
        game.buyTickets{value: PRICE * count}(count);
    }

    function _play(address who, uint256 score) internal returns (uint256 id) {
        vm.prank(op);
        id = game.startGame(who);
        vm.prank(op);
        game.submitScore(id, score);
    }

    // ---------------------------------------------------------------- tickets

    function test_buyTicketsSplitsFee() public {
        _buy(alice, 10);
        assertEq(game.tickets(alice), 10);
        uint256 cost = PRICE * 10;
        assertEq(game.devFees(), cost / 10);
        assertEq(game.pot(), cost - cost / 10);
    }

    function test_buyRejectsWrongPayment() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(StackUltimate.WrongPayment.selector, PRICE * 2, PRICE));
        game.buyTickets{value: PRICE}(2);
    }

    function test_buyRejectsZeroAndTooMany() public {
        vm.startPrank(alice);
        vm.expectRevert(StackUltimate.InvalidCount.selector);
        game.buyTickets(0);
        uint256 tooMany = game.MAX_TICKETS_PER_TX() + 1;
        vm.expectRevert(StackUltimate.InvalidCount.selector);
        game.buyTickets{value: PRICE * tooMany}(tooMany);
        vm.stopPrank();
    }

    function test_plainTransferRejected() public {
        vm.prank(alice);
        (bool ok,) = address(game).call{value: 1 ether}("");
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ games

    function test_startBurnsTicket() public {
        _buy(alice, 2);
        vm.prank(op);
        uint256 id = game.startGame(alice);
        assertEq(id, 1);
        assertEq(game.tickets(alice), 1);
        (address player,, bool open) = game.games(id);
        assertEq(player, alice);
        assertTrue(open);
    }

    function test_startNeedsTicket() public {
        vm.prank(op);
        vm.expectRevert(StackUltimate.NoTickets.selector);
        game.startGame(alice);
    }

    function test_onlyOperatorCanStartOrSubmit() public {
        _buy(alice, 1);
        vm.prank(alice);
        vm.expectRevert(StackUltimate.NotOperator.selector);
        game.startGame(alice);

        vm.prank(op);
        uint256 id = game.startGame(alice);
        vm.prank(alice);
        vm.expectRevert(StackUltimate.NotOperator.selector);
        game.submitScore(id, 999);
    }

    function test_scoreOnlyOnce() public {
        _buy(alice, 1);
        uint256 id = _play(alice, 12);
        vm.prank(op);
        vm.expectRevert(StackUltimate.UnknownGame.selector);
        game.submitScore(id, 50);
        assertEq(game.highScore(), 12);
    }

    function test_unknownGameRejected() public {
        vm.prank(op);
        vm.expectRevert(StackUltimate.UnknownGame.selector);
        game.submitScore(42, 1);
    }

    function test_kingNeedsStrictlyHigherScore() public {
        _buy(alice, 1);
        _buy(bob, 2);
        _play(alice, 20);
        _play(bob, 20);
        assertEq(game.king(), alice);
        _play(bob, 21);
        assertEq(game.king(), bob);
        assertEq(game.bestScore(alice), 20);
        assertEq(game.bestScore(bob), 21);
    }

    // ----------------------------------------------------------------- rounds

    function test_settlementPaysWinnerAndRollsOver() public {
        _buy(alice, 10);
        _play(alice, 30);
        uint256 potBefore = game.pot();

        vm.warp(block.timestamp + ROUND);
        game.settleRound();

        uint256 prize = (potBefore * 8_000) / 10_000;
        assertEq(game.claimable(alice), prize);
        assertEq(game.pot(), potBefore - prize);
        assertEq(game.roundId(), 2);
        assertEq(game.king(), address(0));
        assertEq(game.highScore(), 0);

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        game.claim();
        assertEq(alice.balance, balBefore + prize);
        assertEq(game.claimable(alice), 0);
        assertEq(game.totalClaimable(), 0);
    }

    function test_roundWithoutKingKeepsPot() public {
        _buy(alice, 5);
        uint256 potBefore = game.pot();
        vm.warp(block.timestamp + ROUND);
        game.settleRound();
        assertEq(game.pot(), potBefore);
        assertEq(game.roundId(), 2);
    }

    function test_settleBeforeEndIsNoop() public {
        game.settleRound();
        assertEq(game.roundId(), 1);
    }

    function test_lazySettlementOnBuy() public {
        _buy(alice, 1);
        _play(alice, 5);
        vm.warp(block.timestamp + ROUND + 1);
        _buy(bob, 1);
        assertEq(game.roundId(), 2);
        assertGt(game.claimable(alice), 0);
    }

    function test_gameFromOldRoundDoesNotCrown() public {
        _buy(alice, 1);
        vm.prank(op);
        uint256 id = game.startGame(alice);
        vm.warp(block.timestamp + ROUND);
        vm.prank(op);
        game.submitScore(id, 100);
        assertEq(game.roundId(), 2);
        assertEq(game.king(), address(0));
        assertEq(game.bestScore(alice), 100);
    }

    function test_claimNothingReverts() public {
        vm.prank(alice);
        vm.expectRevert(StackUltimate.NothingToClaim.selector);
        game.claim();
    }

    function test_reentrantClaimCannotDoubleSpend() public {
        ReentrantWinner w = new ReentrantWinner(game);
        w.buy{value: PRICE * 10}(10);
        _play(address(w), 9);
        vm.warp(block.timestamp + ROUND);
        game.settleRound();
        uint256 prize = game.claimable(address(w));
        w.claim();
        assertEq(address(w).balance, prize);
        assertEq(w.reentered(), 1);
        assertGe(address(game).balance, game.pot() + game.devFees() + game.totalClaimable());
    }

    function test_rejectingWinnerDoesNotBlockSettlement() public {
        RejectingWinner w = new RejectingWinner(game);
        w.buy{value: PRICE * 3}(3);
        _play(address(w), 9);
        vm.warp(block.timestamp + ROUND);
        game.settleRound();
        assertEq(game.roundId(), 2);
        _buy(alice, 1);
        _play(alice, 1);
        assertEq(game.king(), alice);
    }

    // ------------------------------------------------------------------ admin

    function test_withdrawFees() public {
        _buy(alice, 10);
        uint256 fees = game.devFees();
        address payable treasury = payable(makeAddr("treasury"));
        game.withdrawFees(treasury);
        assertEq(treasury.balance, fees);
        assertEq(game.devFees(), 0);
        vm.expectRevert(StackUltimate.NothingToClaim.selector);
        game.withdrawFees(treasury);
    }

    function test_adminOnlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(StackUltimate.NotOwner.selector);
        game.setOperator(alice);
        vm.expectRevert(StackUltimate.NotOwner.selector);
        game.setTicketPrice(1);
        vm.expectRevert(StackUltimate.NotOwner.selector);
        game.setFees(0, 10_000);
        vm.expectRevert(StackUltimate.NotOwner.selector);
        game.setPaused(true);
        vm.expectRevert(StackUltimate.NotOwner.selector);
        game.withdrawFees(payable(alice));
        vm.expectRevert(StackUltimate.NotOwner.selector);
        game.setRoundDuration(2 days);
        vm.stopPrank();
    }

    function test_feeCaps() public {
        vm.expectRevert(StackUltimate.InvalidConfig.selector);
        game.setFees(2_001, 8_000);
        vm.expectRevert(StackUltimate.InvalidConfig.selector);
        game.setFees(1_000, 4_999);
        vm.expectRevert(StackUltimate.InvalidConfig.selector);
        game.setFees(1_000, 10_001);
        vm.expectRevert(StackUltimate.InvalidConfig.selector);
        game.setTicketPrice(0);
        vm.expectRevert(StackUltimate.InvalidConfig.selector);
        game.setRoundDuration(59 minutes);
    }

    function test_pauseBlocksBuyAndStart() public {
        _buy(alice, 1);
        game.setPaused(true);
        vm.prank(bob);
        vm.expectRevert(StackUltimate.Paused.selector);
        game.buyTickets{value: PRICE}(1);
        vm.prank(op);
        vm.expectRevert(StackUltimate.Paused.selector);
        game.startGame(alice);
    }

    function test_openGameCanFinishWhilePaused() public {
        _buy(alice, 1);
        vm.prank(op);
        uint256 id = game.startGame(alice);
        game.setPaused(true);
        vm.prank(op);
        game.submitScore(id, 7);
        assertEq(game.highScore(), 7);
    }

    function test_twoStepOwnership() public {
        game.transferOwnership(alice);
        assertEq(game.owner(), owner);
        vm.prank(bob);
        vm.expectRevert(StackUltimate.NotPendingOwner.selector);
        game.acceptOwnership();
        vm.prank(alice);
        game.acceptOwnership();
        assertEq(game.owner(), alice);
        assertEq(game.pendingOwner(), address(0));
    }

    function test_constructorValidation() public {
        vm.expectRevert(StackUltimate.ZeroAddress.selector);
        new StackUltimate(address(0), PRICE, 1_000, 8_000, ROUND);
        vm.expectRevert(StackUltimate.InvalidConfig.selector);
        new StackUltimate(op, 0, 1_000, 8_000, ROUND);
        vm.expectRevert(StackUltimate.InvalidConfig.selector);
        new StackUltimate(op, PRICE, 1_000, 8_000, 30 days + 1);
    }

    function test_getState() public {
        _buy(alice, 3);
        _play(alice, 4);
        StackUltimate.State memory s = game.getState(alice);
        assertEq(s.pot, game.pot());
        assertEq(s.highScore, 4);
        assertEq(s.king, alice);
        assertEq(s.roundId, 1);
        assertEq(s.ticketPrice, PRICE);
        assertFalse(s.paused);
        assertEq(s.tickets, 2);
        assertEq(s.claimable, 0);
        assertEq(s.bestScore, 4);
    }

    // ------------------------------------------------------------------- fuzz

    function testFuzz_solvency(uint8 buys, uint256 seed) public {
        buys = uint8(bound(buys, 1, 40));
        address[3] memory players = [alice, bob, makeAddr("carol")];
        vm.deal(players[2], 10 ether);
        for (uint256 i; i < buys; i++) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address p = players[seed % 3];
            uint256 count = (seed >> 8) % 5 + 1;
            _buy(p, count);
            _play(p, (seed >> 16) % 500);
            if ((seed >> 32) % 4 == 0) vm.warp(block.timestamp + ROUND);
            if ((seed >> 40) % 5 == 0 && game.claimable(p) > 0) {
                vm.prank(p);
                game.claim();
            }
            assertGe(address(game).balance, game.pot() + game.devFees() + game.totalClaimable());
        }
    }
}
