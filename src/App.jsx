/* global BigInt */
import { useState, useEffect } from 'react';
import { usePrivy, useWallets } from '@privy-io/react-auth';
import { createPublicClient, createWalletClient, custom, http, parseEther, formatEther } from 'viem';
import { CONTRACT_ADDRESS, CONTRACT_ABI } from './abi';
import Game from './Game';
import './index.css';

const abstractChain = {
  id: 11124,
  name: 'Abstract Testnet',
  network: 'abstract-testnet',
  nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://api.testnet.abs.xyz'] } },
};

function App() {
  const { login, authenticated, user, logout } = usePrivy();
  const { wallets } = useWallets();
  
  // State
  const [potSize, setPotSize] = useState("0");
  const [highScore, setHighScore] = useState("0");
  const [tickets, setTickets] = useState(0);
  const [xp, setXp] = useState(0);
  const [king, setKing] = useState("0x...");
  const [buyAmount, setBuyAmount] = useState(5);
  
  // Game State
  const [isGameActive, setIsGameActive] = useState(false);
  const [isWriting, setIsWriting] = useState(false);

  // --- FETCH DATA ---
  const fetchGameState = async () => {
    try {
      const publicClient = createPublicClient({ chain: abstractChain, transport: http() });
      const playerAddress = user?.wallet?.address || "0x0000000000000000000000000000000000000000";
      
      const data = await publicClient.readContract({
        address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: 'get_game_state',
        args: [playerAddress]
      });
      
      setPotSize(formatEther(data[0]));
      setHighScore(data[1].toString());
      setKing(data[2]);
      setTickets(Number(data[4]));
      setXp(Number(data[5]));
    } catch (error) { console.error("Read Error:", error); }
  };

  useEffect(() => {
    fetchGameState();
    const interval = setInterval(fetchGameState, 5000);
    return () => clearInterval(interval);
  }, [user]);

  const getSigner = async () => {
    const wallet = wallets[0];
    if (!wallet) throw new Error("No wallet");
    await wallet.switchChain(11124);
    const provider = await wallet.getEthereumProvider();
    return createWalletClient({ account: wallet.address, chain: abstractChain, transport: custom(provider) });
  };

  const handleBuyTickets = async () => {
    try {
      setIsWriting(true);
      const client = await getSigner();
      const [address] = await client.getAddresses();
      const cost = (buyAmount * 0.0001).toFixed(4).toString();
      
      await client.writeContract({
        address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: 'buy_tickets',
        account: address, args: [BigInt(buyAmount)], value: parseEther(cost), gas: BigInt(500000)
      });
      
      alert(`Success! Purchased ${buyAmount} Tickets.`);
      setIsWriting(false);
      fetchGameState();
    } catch (error) {
      console.error(error);
      setIsWriting(false);
      alert("Purchase Failed");
    }
  };

  const handleStartGame = () => {
    if (tickets > 0) {
        setIsGameActive(true);
    } else {
        alert("No Tickets! Buy some to enter.");
    }
  };

  const handleGameOver = async (score) => {
    setIsGameActive(false);
    if (score === 0) return;
    
    setTickets(prev => Math.max(0, prev - 1));
    alert(`Game Over! Score: ${score}. Ticket Used.`);
    
    // Silent Submit
    try {
      const client = await getSigner();
      const [address] = await client.getAddresses();
      await client.writeContract({
        address: CONTRACT_ADDRESS, abi: CONTRACT_ABI, functionName: 'play_round',
        account: address, args: [BigInt(score)]
      });
      fetchGameState();
    } catch (e) { console.error("Silent submit error", e); }
  };

  return (
    <div className="app-container">
      <div className="top-bar">
        <div className="logo">STACK <span className="highlight">PRO</span></div>
        <div className="ticker">🎟 {tickets} | ⭐ {xp} XP | 💰 {potSize} ETH</div>
        {authenticated ? 
            <button onClick={logout} className="connect-btn">LOGOUT</button> : 
            <button onClick={login} className="connect-btn">LOGIN</button>
        }
      </div>

      <div className="arena">
        {/* GAME COMPONENT */}
        {isGameActive && <Game gameActive={isGameActive} onGameOver={handleGameOver} />}

        {!authenticated ? (
          <div className="welcome-card" style={{zIndex: 10}}>
            <h1>PROOF OF SKILL</h1>
            <button onClick={login} className="play-btn">LOGIN TO PLAY</button>
          </div>
        ) : (
          !isGameActive && (
            <div className="lobby-card" style={{zIndex: 10}}>
                <div className="stats-row">
                  <div className="stat-box"><div className="label">POT</div><div className="value glow-green">{potSize} ETH</div></div>
                  <div className="stat-box"><div className="label">HIGH SCORE</div><div className="value">{highScore}</div></div>
                </div>
                <div className="xp-bar"><div className="xp-fill" style={{width: `${(xp % 1000)/10}%`}}></div></div>

                {tickets > 0 ? (
                    <button className="play-btn" onClick={handleStartGame}>PLAY NOW ({tickets})</button>
                ) : (
                    <div className="ticket-shop">
                        <div className="ticket-controls">
                            <button className="control-btn" onClick={() => setBuyAmount(Math.max(1, buyAmount - 1))}>-</button>
                            <div className="ticket-input">{buyAmount}</div>
                            <button className="control-btn" onClick={() => setBuyAmount(Math.min(50, buyAmount + 1))}>+</button>
                        </div>
                        <button className="buy-btn" onClick={handleBuyTickets} disabled={isWriting}>
                            {isWriting ? "..." : `BUY FOR ${(buyAmount * 0.0001).toFixed(4)} ETH`}
                        </button>
                    </div>
                )}
                <div className="king-display">King: {king.substring(0,8)}...</div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

export default App;