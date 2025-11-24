export const CONTRACT_ADDRESS = "0x27D53d1c60Ea8c8dc95B398dB98549536aA36F9E";

export const CONTRACT_ABI = [
	{ "inputs": [], "stateMutability": "nonpayable", "type": "constructor" },
	{ "anonymous": false, "inputs": [ { "indexed": true, "internalType": "address", "name": "player", "type": "address" }, { "indexed": false, "internalType": "uint256", "name": "count", "type": "uint256" } ], "name": "TicketsBought", "type": "event" },
	{ "anonymous": false, "inputs": [ { "indexed": true, "internalType": "address", "name": "player", "type": "address" }, { "indexed": false, "internalType": "uint256", "name": "score", "type": "uint256" }, { "indexed": false, "internalType": "uint256", "name": "xpEarned", "type": "uint256" } ], "name": "GameResult", "type": "event" },
    { "inputs": [ { "internalType": "uint256", "name": "count", "type": "uint256" } ], "name": "buy_tickets", "outputs": [], "stateMutability": "payable", "type": "function" },
    { "inputs": [ { "internalType": "address", "name": "player", "type": "address" } ], "name": "get_game_state", "outputs": [ { "internalType": "uint256", "name": "", "type": "uint256" }, { "internalType": "uint256", "name": "", "type": "uint256" }, { "internalType": "address", "name": "", "type": "address" }, { "internalType": "uint256", "name": "", "type": "uint256" }, { "internalType": "uint256", "name": "", "type": "uint256" }, { "internalType": "uint256", "name": "", "type": "uint256" } ], "stateMutability": "view", "type": "function" },
    { "inputs": [ { "internalType": "uint256", "name": "score", "type": "uint256" } ], "name": "play_round", "outputs": [], "stateMutability": "nonpayable", "type": "function" }
];