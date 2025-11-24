import React, { useEffect, useRef } from "react";

const Game = ({ gameActive, onGameOver }) => {
  const iframeRef = useRef(null);

  useEffect(() => {
    const handleMessage = (event) => {
      if (event.data && event.data.type === "GAME_OVER") {
        onGameOver(event.data.score);
      }
    };
    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onGameOver]);

  useEffect(() => {
    // Focus the iframe so keyboard works immediately
    if(iframeRef.current) iframeRef.current.focus();
  }, []);

  if (!gameActive) return null;

  return (
    <div style={{ position: "fixed", top: 0, left: 0, width: "100vw", height: "100vh", zIndex: 1, background: "#000" }}>
      <iframe 
        ref={iframeRef}
        src="/game/index.html" 
        title="Stack Pro"
        style={{width: '100%', height: '100%', border: 'none', display: 'block'}}
        scrolling="no"
      />
      <button 
        onClick={() => onGameOver(0)}
        style={{
            position:'absolute', top: 20, right: 20, 
            padding: '10px 20px', background:'rgba(0,0,0,0.5)', color:'white', 
            border:'1px solid rgba(255,255,255,0.2)', borderRadius:'30px', 
            cursor:'pointer', fontWeight:'bold', backdropFilter: 'blur(5px)'
        }}
      >
        EXIT
      </button>
    </div>
  );
};

export default Game;