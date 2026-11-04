// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title Stack Ultimate - ticketed, king-of-the-round stacking game on Base.
/// @notice Players buy tickets once (one wallet transaction). After that every
///         game is started and scored by the game server ("operator"), so the
///         player never signs again. The server replays each run from its raw
///         click timeline before it submits a score.
/// @dev Trust model: the operator decides scores. It cannot move the pot or the
///      fees; the worst a compromised operator can do is crown the wrong king
///      for a round, and the owner can rotate it at any time.
///      Payouts use pull payments (`claim`) so a reverting winner cannot block
///      settlement.
contract StackUltimate {
    // ---------------------------------------------------------------- errors
    error NotOwner();
    error NotPendingOwner();
    error NotOperator();
    error Paused();
    error ZeroAddress();
    error InvalidCount();
    error WrongPayment(uint256 expected, uint256 sent);
    error NoTickets();
    error UnknownGame();
    error NothingToClaim();
    error TransferFailed();
    error InvalidConfig();
    error Reentrancy();

    // ---------------------------------------------------------------- events
    event TicketsBought(address indexed player, uint256 count, uint256 paid, uint256 roundId);
    event GameStarted(address indexed player, uint256 indexed gameId, uint256 roundId);
    event GameResult(address indexed player, uint256 indexed gameId, uint256 score, uint256 roundId, bool counted);
    event NewHighScore(address indexed player, uint256 score, uint256 roundId);
    event RoundSettled(uint256 indexed roundId, address indexed winner, uint256 score, uint256 prize, uint256 rollover);
    event Claimed(address indexed player, uint256 amount);
    event OperatorChanged(address indexed operator);
    event TicketPriceChanged(uint256 price);
    event FeesChanged(uint16 devFeeBps, uint16 winnerBps);
    event RoundDurationChanged(uint64 duration);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event FeesWithdrawn(address indexed to, uint256 amount);
    event PotFunded(address indexed from, uint256 amount);

    // ------------------------------------------------------------- constants
    uint16 public constant MAX_DEV_FEE_BPS = 2_000; // 20%
    uint16 public constant MIN_WINNER_BPS = 5_000; // 50%
    uint16 public constant BPS = 10_000;
    uint256 public constant MAX_TICKETS_PER_TX = 100;
    uint64 public constant MIN_ROUND_DURATION = 1 hours;
    uint64 public constant MAX_ROUND_DURATION = 30 days;

    // ----------------------------------------------------------------- roles
    address public owner;
    address public pendingOwner;
    address public operator;
    bool public paused;

    // ---------------------------------------------------------------- config
    uint256 public ticketPrice;
    uint16 public devFeeBps; // share of each ticket sale kept as fees
    uint16 public winnerBps; // share of the pot paid to the round winner
    uint64 public roundDuration;

    // ----------------------------------------------------------------- state
    uint256 public pot;
    uint256 public devFees;
    uint256 public totalClaimable; // owed to winners, never part of pot/fees

    uint256 public roundId;
    uint64 public roundEndsAt;
    address public king;
    uint256 public highScore;

    uint256 public gameCount;

    struct Game {
        address player;
        uint64 roundId;
        bool open;
    }

    mapping(address => uint256) public tickets;
    mapping(address => uint256) public claimable;
    mapping(address => uint256) public bestScore; // all-time best per player
    mapping(uint256 => Game) public games;

    uint256 private _lock = 1;

    // ------------------------------------------------------------- modifiers
    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    constructor(address operator_, uint256 ticketPrice_, uint16 devFeeBps_, uint16 winnerBps_, uint64 roundDuration_) {
        if (operator_ == address(0)) revert ZeroAddress();
        if (ticketPrice_ == 0) revert InvalidConfig();
        _checkFees(devFeeBps_, winnerBps_);
        _checkDuration(roundDuration_);

        owner = msg.sender;
        operator = operator_;
        ticketPrice = ticketPrice_;
        devFeeBps = devFeeBps_;
        winnerBps = winnerBps_;
        roundDuration = roundDuration_;

        roundId = 1;
        roundEndsAt = uint64(block.timestamp) + roundDuration_;

        emit OwnershipTransferred(address(0), msg.sender);
        emit OperatorChanged(operator_);
    }

    // ================================================================ player

    /// @notice Buy `count` tickets for yourself. Send exactly count * ticketPrice.
    function buyTickets(uint256 count) external payable whenNotPaused nonReentrant {
        if (count == 0 || count > MAX_TICKETS_PER_TX) revert InvalidCount();
        uint256 cost = count * ticketPrice;
        if (msg.value != cost) revert WrongPayment(cost, msg.value);

        _settleIfEnded();

        uint256 fee = (cost * devFeeBps) / BPS;
        devFees += fee;
        pot += cost - fee;
        tickets[msg.sender] += count;

        emit TicketsBought(msg.sender, count, cost, roundId);
    }

    /// @notice Withdraw prize money owed to you.
    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit Claimed(msg.sender, amount);
    }

    /// @notice Anyone may close a round once its time is up.
    function settleRound() external nonReentrant {
        _settleIfEnded();
    }

    /// @notice Anyone can sponsor the pot.
    function fundPot() external payable nonReentrant {
        if (msg.value == 0) revert InvalidCount();
        pot += msg.value;
        emit PotFunded(msg.sender, msg.value);
    }

    // ============================================================== operator

    /// @notice Burns one ticket and opens a game for `player`.
    function startGame(address player) external onlyOperator whenNotPaused nonReentrant returns (uint256 gameId) {
        if (tickets[player] == 0) revert NoTickets();
        _settleIfEnded();

        unchecked {
            tickets[player] -= 1;
            gameId = ++gameCount;
        }
        games[gameId] = Game({player: player, roundId: uint64(roundId), open: true});
        emit GameStarted(player, gameId, roundId);
    }

    /// @notice Records the verified score of an open game. Each game can be
    ///         scored exactly once. Scores of games started in an earlier round
    ///         are recorded but cannot take the current round's crown.
    function submitScore(uint256 gameId, uint256 score) external onlyOperator nonReentrant {
        Game storage g = games[gameId];
        if (!g.open) revert UnknownGame();
        g.open = false;
        address player = g.player;

        _settleIfEnded();

        bool counted = g.roundId == roundId;
        if (counted && score > highScore) {
            highScore = score;
            king = player;
            emit NewHighScore(player, score, roundId);
        }
        if (score > bestScore[player]) bestScore[player] = score;

        emit GameResult(player, gameId, score, g.roundId, counted);
    }

    // ================================================================= views

    struct State {
        uint256 pot;
        uint256 highScore;
        address king;
        uint256 roundId;
        uint64 roundEndsAt;
        uint256 ticketPrice;
        bool paused;
        uint256 tickets;
        uint256 claimable;
        uint256 bestScore;
    }

    /// @notice Everything the lobby needs in one call.
    function getState(address player) external view returns (State memory s) {
        s.pot = pot;
        s.highScore = highScore;
        s.king = king;
        s.roundId = roundId;
        s.roundEndsAt = roundEndsAt;
        s.ticketPrice = ticketPrice;
        s.paused = paused;
        s.tickets = tickets[player];
        s.claimable = claimable[player];
        s.bestScore = bestScore[player];
    }

    // ================================================================= owner

    function setOperator(address operator_) external onlyOwner {
        if (operator_ == address(0)) revert ZeroAddress();
        operator = operator_;
        emit OperatorChanged(operator_);
    }

    function setTicketPrice(uint256 price) external onlyOwner {
        if (price == 0) revert InvalidConfig();
        ticketPrice = price;
        emit TicketPriceChanged(price);
    }

    function setFees(uint16 devFeeBps_, uint16 winnerBps_) external onlyOwner {
        _checkFees(devFeeBps_, winnerBps_);
        devFeeBps = devFeeBps_;
        winnerBps = winnerBps_;
        emit FeesChanged(devFeeBps_, winnerBps_);
    }

    /// @dev Takes effect from the next round.
    function setRoundDuration(uint64 duration) external onlyOwner {
        _checkDuration(duration);
        roundDuration = duration;
        emit RoundDurationChanged(duration);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedSet(paused_);
    }

    function withdrawFees(address payable to) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        uint256 amount = devFees;
        if (amount == 0) revert NothingToClaim();
        devFees = 0;
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
        emit FeesWithdrawn(to, amount);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, msg.sender);
        owner = msg.sender;
        pendingOwner = address(0);
    }

    // ============================================================== internal

    function _settleIfEnded() internal {
        if (block.timestamp < roundEndsAt) return;

        address winner = king;
        uint256 prize;
        if (winner != address(0) && pot > 0) {
            prize = (pot * winnerBps) / BPS;
            pot -= prize;
            claimable[winner] += prize;
            totalClaimable += prize;
        }
        emit RoundSettled(roundId, winner, highScore, prize, pot);

        unchecked {
            roundId += 1;
        }
        king = address(0);
        highScore = 0;
        roundEndsAt = uint64(block.timestamp) + roundDuration;
    }

    function _checkFees(uint16 devFeeBps_, uint16 winnerBps_) private pure {
        if (devFeeBps_ > MAX_DEV_FEE_BPS) revert InvalidConfig();
        if (winnerBps_ < MIN_WINNER_BPS || winnerBps_ > BPS) revert InvalidConfig();
    }

    function _checkDuration(uint64 duration) private pure {
        if (duration < MIN_ROUND_DURATION || duration > MAX_ROUND_DURATION) revert InvalidConfig();
    }

    /// @dev Plain transfers are refused so ETH can only enter through
    ///      buyTickets / fundPot and the accounting always matches the balance.
    receive() external payable {
        revert InvalidCount();
    }
}
