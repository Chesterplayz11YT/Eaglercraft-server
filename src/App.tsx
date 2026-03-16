/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import { Server, Users, Activity, Globe, Terminal, Copy, Check, Mic, MicOff, Volume2, VolumeX, MessageSquare, Shield } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

// --- Voice Chat Logic ---
const PROXIMITY_RADIUS = 50; // Blocks

export default function App() {
  const [copied, setCopied] = useState(false);
  const [relayCopied, setRelayCopied] = useState(false);
  const [status, setStatus] = useState<'online' | 'offline' | 'starting'>('starting');
  const [isMicOn, setIsMicOn] = useState(false);
  const [room, setRoom] = useState('global');
  const [username, setUsername] = useState('');
  const [peers, setPeers] = useState<Record<string, any>>({});
  const [positions, setPositions] = useState<Record<string, { x: number, y: number, z: number }>>({});
  const [playerCount, setPlayerCount] = useState(0);
  
  const wsUrl = window.location.origin.replace(/^http/, 'ws');
  const relayUrl = `${wsUrl}/relay`;
  
  const relayWs = useRef<WebSocket | null>(null);
  const localStream = useRef<MediaStream | null>(null);
  const peerConnections = useRef<Record<string, RTCPeerConnection>>({});
  const audioContext = useRef<AudioContext | null>(null);
  const remoteGains = useRef<Record<string, GainNode>>({});

  useEffect(() => {
    // Initialize Relay Connection for Voice
    const ws = new WebSocket(relayUrl);
    relayWs.current = ws;

    ws.onopen = () => {
      console.log('Voice relay connected');
      setStatus('online');
      ws.send(JSON.stringify({ type: 'join', room, username }));
    };

    ws.onmessage = async (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        if (msg.type === 'positions') {
          setPositions(msg.data);
          setPlayerCount(Object.keys(msg.data).length);
          updateProximityVolumes(msg.data);
          return;
        }

        if (msg.type === 'offer') {
          handleOffer(msg);
        } else if (msg.type === 'answer') {
          handleAnswer(msg);
        } else if (msg.type === 'candidate') {
          handleCandidate(msg);
        } else if (msg.type === 'new-peer') {
          createOffer(msg.from);
        }
      } catch (e) {
        // Ignore non-JSON
      }
    };

    return () => ws.close();
  }, [room, username]);

  const updateProximityVolumes = (posData: Record<string, { x: number, y: number, z: number }>) => {
    if (!username || !posData[username]) return;
    const myPos = posData[username];

    Object.entries(remoteGains.current).forEach(([peerName, node]) => {
      const gainNode = node as GainNode;
      const peerPos = posData[peerName];
      if (!peerPos) {
        gainNode.gain.value = 0;
        return;
      }

      const dist = Math.sqrt(
        Math.pow(myPos.x - peerPos.x, 2) +
        Math.pow(myPos.y - peerPos.y, 2) +
        Math.pow(myPos.z - peerPos.z, 2)
      );

      // Linear falloff
      const volume = Math.max(0, 1 - (dist / PROXIMITY_RADIUS));
      gainNode.gain.setTargetAtTime(volume, audioContext.current?.currentTime || 0, 0.1);
    });
  };

  const toggleMic = async () => {
    if (isMicOn) {
      localStream.current?.getTracks().forEach(t => t.stop());
      localStream.current = null;
      setIsMicOn(false);
    } else {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStream.current = stream;
        setIsMicOn(true);
        
        // Notify others we are online
        relayWs.current?.send(JSON.stringify({ type: 'new-peer', from: username }));
      } catch (err) {
        alert('Could not access microphone');
      }
    }
  };

  const createOffer = async (to: string) => {
    const pc = createPeerConnection(to);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    relayWs.current?.send(JSON.stringify({ type: 'offer', offer, to, from: username }));
  };

  const handleOffer = async (msg: any) => {
    const pc = createPeerConnection(msg.from);
    await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    relayWs.current?.send(JSON.stringify({ type: 'answer', answer, to: msg.from, from: username }));
  };

  const handleAnswer = async (msg: any) => {
    const pc = peerConnections.current[msg.from];
    if (pc) {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
    }
  };

  const handleCandidate = async (msg: any) => {
    const pc = peerConnections.current[msg.from];
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    }
  };

  const createPeerConnection = (peerName: string) => {
    if (peerConnections.current[peerName]) return peerConnections.current[peerName];

    const pc = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    });

    peerConnections.current[peerName] = pc;

    if (localStream.current) {
      localStream.current.getTracks().forEach(track => pc.addTrack(track, localStream.current!));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        relayWs.current?.send(JSON.stringify({ type: 'candidate', candidate: event.candidate, to: peerName, from: username }));
      }
    };

    pc.ontrack = (event) => {
      const stream = event.streams[0];
      playRemoteStream(peerName, stream);
    };

    return pc;
  };

  const playRemoteStream = (peerName: string, stream: MediaStream) => {
    if (!audioContext.current) {
      audioContext.current = new (window.AudioContext || (window as any).webkitAudioContext)();
    }

    const source = audioContext.current.createMediaStreamSource(stream);
    const gainNode = audioContext.current.createGain();
    
    source.connect(gainNode);
    gainNode.connect(audioContext.current.destination);
    
    remoteGains.current[peerName] = gainNode;
    setPeers(prev => ({ ...prev, [peerName]: { active: true } }));
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      if (status === 'starting') setStatus('offline');
    }, 5000);
    return () => clearTimeout(timer);
  }, [status]);

  const copyToClipboard = () => {
    navigator.clipboard.writeText(wsUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const copyRelayToClipboard = () => {
    navigator.clipboard.writeText(relayUrl);
    setRelayCopied(true);
    setTimeout(() => setRelayCopied(false), 2000);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-zinc-100 font-sans selection:bg-emerald-500/30">
      {/* Background Glow */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-[10%] -left-[10%] w-[40%] h-[40%] bg-emerald-500/10 blur-[120px] rounded-full" />
        <div className="absolute -bottom-[10%] -right-[10%] w-[40%] h-[40%] bg-blue-500/10 blur-[120px] rounded-full" />
      </div>

      <main className="relative max-w-5xl mx-auto px-6 py-12 md:py-24">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="space-y-12"
        >
          {/* Header */}
          <header className="space-y-4">
            <div className="flex flex-wrap items-center gap-4">
              <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-medium tracking-wider uppercase">
                <span className="relative flex h-2 w-2">
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${status === 'online' ? 'bg-emerald-400' : 'bg-amber-400'}`}></span>
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${status === 'online' ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                </span>
                Server {status}
              </div>
              <button 
                onClick={copyToClipboard}
                className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-white/5 border border-white/10 text-zinc-400 text-xs font-medium hover:bg-white/10 transition-colors"
              >
                {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
                {copied ? 'Copied!' : 'Copy IP'}
              </button>
            </div>
            <h1 className="text-5xl md:text-7xl font-bold tracking-tight bg-gradient-to-b from-white to-zinc-500 bg-clip-text text-transparent">
              Survival<br />LifeSteal
            </h1>
            <p className="text-lg text-zinc-400 max-w-2xl leading-relaxed">
              A hardcore survival experience. Kill players to gain hearts, but be careful—losing a fight means losing your max health.
            </p>
          </header>

          {/* Stats Grid */}
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            {[
              { label: 'Mode', value: 'Survival', icon: Server },
              { label: 'Players', value: `${playerCount} / 100`, icon: Users },
              { label: 'Plugin', value: 'LifeSteal', icon: Activity },
              { label: 'Difficulty', value: 'Normal', icon: Shield },
            ].map((stat, i) => (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.1 * i }}
                className="p-6 rounded-2xl bg-zinc-900/50 border border-white/5 backdrop-blur-sm hover:border-white/10 transition-colors"
              >
                <stat.icon className="w-5 h-5 text-zinc-500 mb-4" />
                <div className="text-xs text-zinc-500 uppercase tracking-widest font-semibold mb-1">{stat.label}</div>
                <div className="text-2xl font-medium">{stat.value}</div>
              </motion.div>
            ))}
          </div>

          {/* Voice Chat Controls */}
          <section className="p-8 rounded-3xl bg-zinc-900/30 border border-white/5 backdrop-blur-xl">
            <div className="flex flex-col md:flex-row gap-8 items-start justify-between">
              <div className="space-y-4 max-w-md">
                <h2 className="text-3xl font-bold flex items-center gap-3 text-emerald-400">
                  <Mic className="w-8 h-8" />
                  Proximity Voice
                </h2>
                <p className="text-zinc-400 leading-relaxed">
                  Real-time proximity chat. Enter your Minecraft username to sync your position and talk to nearby players.
                </p>
                
                <div className="flex gap-2">
                  <input 
                    type="text" 
                    placeholder="MC Username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    className="flex-1 bg-black border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-emerald-500/50 transition-colors"
                  />
                  <select 
                    value={room}
                    onChange={(e) => setRoom(e.target.value)}
                    className="bg-black border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-emerald-500/50"
                  >
                    <option value="global">Global Room</option>
                    <option value="private-1">Private Room 1</option>
                    <option value="private-2">Private Room 2</option>
                    <option value="staff">Staff Only</option>
                  </select>
                </div>
              </div>

              <div className="flex flex-col items-center gap-4">
                <motion.button
                  whileHover={{ scale: 1.05 }}
                  whileTap={{ scale: 0.95 }}
                  onClick={toggleMic}
                  className={`w-24 h-24 rounded-full flex items-center justify-center transition-all shadow-2xl ${
                    isMicOn 
                    ? 'bg-emerald-500 text-white shadow-emerald-500/20' 
                    : 'bg-zinc-800 text-zinc-500'
                  }`}
                >
                  {isMicOn ? <Mic className="w-10 h-10" /> : <MicOff className="w-10 h-10" />}
                </motion.button>
                <span className="text-xs font-bold uppercase tracking-widest text-zinc-500">
                  {isMicOn ? 'Microphone Active' : 'Mic Muted'}
                </span>
              </div>
            </div>

            {/* Active Peers */}
            <div className="mt-8 pt-8 border-t border-white/5">
              <div className="flex flex-wrap gap-4">
                <AnimatePresence>
                  {Object.keys(peers).map((peerName) => (
                    <motion.div
                      key={peerName}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-white/5 border border-white/10"
                    >
                      <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                      <span className="text-xs font-medium">{peerName}</span>
                      <Volume2 className="w-3 h-3 text-zinc-500" />
                    </motion.div>
                  ))}
                </AnimatePresence>
                {Object.keys(peers).length === 0 && (
                  <p className="text-xs text-zinc-600 italic">No other players in voice range...</p>
                )}
              </div>
            </div>
          </section>

          {/* Connection Cards */}
          <div className="grid grid-cols-1 gap-6">
            <section className="p-8 rounded-3xl bg-gradient-to-br from-zinc-900 to-black border border-white/10 shadow-2xl">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-8">
                <div className="space-y-2">
                  <h2 className="text-2xl font-semibold flex items-center gap-2">
                    <Globe className="w-6 h-6 text-emerald-500" />
                    Connect to Server
                  </h2>
                  <p className="text-zinc-400">Copy this WebSocket URL into your Eaglercraft client.</p>
                </div>
                
                <div className="flex items-center gap-2 p-2 rounded-xl bg-black border border-white/5 group">
                  <code className="px-4 py-2 font-mono text-emerald-400 text-sm md:text-base break-all">
                    {wsUrl}
                  </code>
                  <button 
                    onClick={copyToClipboard}
                    className="p-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-all active:scale-95"
                  >
                    {copied ? <Check className="w-5 h-5 text-emerald-500" /> : <Copy className="w-5 h-5" />}
                  </button>
                </div>
              </div>
            </section>

            <section className="p-8 rounded-3xl bg-gradient-to-br from-zinc-900 to-black border border-white/10 shadow-2xl">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-8">
                <div className="space-y-2">
                  <h2 className="text-2xl font-semibold flex items-center gap-2">
                    <Activity className="w-6 h-6 text-blue-500" />
                    Relay Server
                  </h2>
                  <p className="text-zinc-400">Use this URL for WebRTC signaling (Share to LAN).</p>
                </div>
                
                <div className="flex items-center gap-2 p-2 rounded-xl bg-black border border-white/5 group">
                  <code className="px-4 py-2 font-mono text-blue-400 text-sm md:text-base break-all">
                    {relayUrl}
                  </code>
                  <button 
                    onClick={copyRelayToClipboard}
                    className="p-3 rounded-lg bg-zinc-800 hover:bg-zinc-700 transition-all active:scale-95"
                  >
                    {relayCopied ? <Check className="w-5 h-5 text-emerald-500" /> : <Copy className="w-5 h-5" />}
                  </button>
                </div>
              </div>
            </section>
          </div>

          {/* Instructions */}
          <section className="grid grid-cols-1 md:grid-cols-2 gap-8">
            <div className="space-y-4">
              <h3 className="text-xl font-medium flex items-center gap-2">
                <Terminal className="w-5 h-5 text-blue-500" />
                How to Play
              </h3>
              <ul className="space-y-3 text-zinc-400 text-sm leading-relaxed">
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-white">1</span>
                  Open any Eaglercraft 1.8.8 web client.
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-white">2</span>
                  Go to "Multiplayer" and click "Add Server".
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-white">3</span>
                  Paste the WebSocket URL above into the "Server Address" field.
                </li>
                <li className="flex gap-3">
                  <span className="flex-shrink-0 w-6 h-6 rounded-full bg-zinc-800 flex items-center justify-center text-xs font-bold text-white">4</span>
                  Join and enjoy your hardcore world!
                </li>
              </ul>
            </div>

            <div className="space-y-4">
              <h3 className="text-xl font-medium flex items-center gap-2 text-emerald-400">
                <Server className="w-5 h-5" />
                Actual Minecraft 1.8
              </h3>
              <div className="p-4 rounded-xl bg-zinc-900/50 border border-white/5 text-xs space-y-3 text-zinc-400">
                <p>Standard Minecraft clients use TCP, but this server uses WebSockets on port 3000. To join with a real launcher:</p>
                <ol className="list-decimal list-inside space-y-1">
                  <li>Download a <strong>WebSocket to TCP proxy</strong> (like <code className="text-zinc-200">websockify</code>).</li>
                  <li>Run: <code className="text-emerald-500">websockify 25565 {wsUrl.replace('wss://', '')}</code></li>
                  <li>In your 1.8.8 launcher, connect to: <code className="text-zinc-200">localhost:25565</code></li>
                </ol>
                <p className="text-[10px] opacity-50 italic">Note: Eaglercraft clients are recommended for the best experience.</p>
              </div>
            </div>

            <div className="p-6 rounded-2xl bg-red-500/5 border border-red-500/10 md:col-span-2">
              <h3 className="text-lg font-medium text-red-400 mb-2">LifeSteal Rules</h3>
              <ul className="space-y-2 text-sm text-zinc-400">
                <li>• Kill a player: +1 Heart (Max Health)</li>
                <li>• Die to a player: -1 Heart (Max Health)</li>
                <li>• Spawn Town: 50x50 unbreakable safe zone at 0,0</li>
                <li>• 1-Heart Reset: Reaching 1 heart resets you to 10 hearts (Once)</li>
                <li>• Hardcore Death: Dying at 1 heart after reset = Permanent Ban</li>
                <li>• Nether Star: Right-click to gain +1 Heart</li>
                <li>• Custom Ruins: Explore the map to find stone ruins with loot</li>
                <li>• Massive Dungeons: Rare, large structures with Legendary Loot</li>
                <li>• Kingdom Villages: Small clusters of houses with common loot</li>
                <li>• Loot Chests: Find chests in structures for tiered loot</li>
                <li>• Armor Sets: Find Iron, Gold, Chainmail, and Diamond armor in chests</li>
                <li>• Recipe Book: Spawn with a guide to help you craft and survive</li>
                <li>• World Border: The map is limited to 100,000 x 100,000 blocks</li>
              </ul>
            </div>
          </section>
        </motion.div>
      </main>

      <footer className="max-w-5xl mx-auto px-6 py-12 border-t border-white/5 text-center text-zinc-600 text-xs tracking-widest uppercase">
        Built with Google AI Studio & Flying Squid
      </footer>
    </div>
  );
}
