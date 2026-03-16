import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import mcServer from 'flying-squid';
import net from 'net';

async function startServer() {
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true });
  const relayClients = new Set<any>();
  const playerPositions = new Map<string, { x: number, y: number, z: number }>();

  // 1. Start the Minecraft Server (flying-squid)
  const MC_PORT = 25565;
  
  // LifeSteal & Ruins Plugin Logic
  const customPlugin = (serv: any) => {
    // --- LifeSteal Logic ---
    const secondChanceUsed = new Set<string>();

    serv.on('playerDeath', ({ player, killer }: any) => {
      if (killer && killer.type === 'player' && killer.username !== player.username) {
        const killerMax = killer.maxHealth || 20;
        killer.maxHealth = killerMax + 2;
        killer.health = killer.maxHealth;
        killer.chat(`§a§lLifeSteal > §fYou killed §e${player.username}§f and gained a heart!`);
        
        const playerMax = player.maxHealth || 20;
        const newMax = playerMax - 2;
        
        if (newMax <= 0) {
          player.kick('§c§lHARDCORE DEATH > §fYou lost all your hearts!');
          return;
        }

        player.maxHealth = newMax;
        player.chat(`§c§lLifeSteal > §fYou were killed by §e${killer.username}§f and lost a heart!`);
        
        if (player.maxHealth <= 2) {
          if (!secondChanceUsed.has(player.username)) {
            secondChanceUsed.add(player.username);
            player.maxHealth = 20;
            player.health = 20;
            player.chat('§6§lSECOND CHANCE > §fYou reached 1 heart! Your health has been reset to 10 hearts.');
          } else {
            player.kick('§c§lHARDCORE DEATH > §fYou lost your last heart after using your second chance!');
            serv.broadcast(`§4§lELIMINATION > §e${player.username}§f has been eliminated!`);
          }
        }
      }
    });

    // --- World Border Logic ---
    const BORDER_SIZE = 100000;
    const BORDER_HALF = BORDER_SIZE / 2;
    const SPAWN_RADIUS = 25;

    const isAtSpawn = (pos: { x: number, z: number }) => {
      return Math.abs(pos.x) <= SPAWN_RADIUS && Math.abs(pos.z) <= SPAWN_RADIUS;
    };

    const generateSpawnTown = () => {
      const y = 60; // Base height
      console.log('Generating Spawn Town...');
      
      // Clear area and make floor
      for (let x = -SPAWN_RADIUS; x <= SPAWN_RADIUS; x++) {
        for (let z = -SPAWN_RADIUS; z <= SPAWN_RADIUS; z++) {
          // Floor - Stone Bricks for the town
          serv.setBlock(serv.overworld, { x: x, y: y, z: z }, 98, 0); 
          
          // Clear air above
          for (let dy = 1; dy < 15; dy++) {
            serv.setBlock(serv.overworld, { x: x, y: y + dy, z: z }, 0, 0);
          }

          // Paths - Gravel
          if (Math.abs(x) < 3 || Math.abs(z) < 3) {
            serv.setBlock(serv.overworld, { x: x, y: y, z: z }, 13, 0); 
          }

          // Walls - Cobblestone Walls
          if (Math.abs(x) === SPAWN_RADIUS || Math.abs(z) === SPAWN_RADIUS) {
            for (let dy = 1; dy < 5; dy++) {
              serv.setBlock(serv.overworld, { x: x, y: y + dy, z: z }, 98, 0); // Stone Bricks
            }
            // Add some glowstone on top of walls
            serv.setBlock(serv.overworld, { x: x, y: y + 5, z: z }, 89, 0);
          }
        }
      }

      // Central Fountain
      for (let dx = -3; dx <= 3; dx++) {
        for (let dz = -3; dz <= 3; dz++) {
          serv.setBlock(serv.overworld, { x: dx, y: y + 1, z: dz }, 98, 0);
          if (Math.abs(dx) < 3 && Math.abs(dz) < 3) {
            serv.setBlock(serv.overworld, { x: dx, y: y + 1, z: dz }, 9, 0); // Water
          }
        }
      }
      serv.setBlock(serv.overworld, { x: 0, y: y + 2, z: 0 }, 98, 0);
      serv.setBlock(serv.overworld, { x: 0, y: y + 3, z: 0 }, 98, 0);
      serv.setBlock(serv.overworld, { x: 0, y: y + 4, z: 0 }, 9, 0); // Water source

      // Some basic houses at corners
      const corners = [
        {cx: 15, cz: 15}, {cx: -15, cz: 15}, {cx: 15, cz: -15}, {cx: -15, cz: -15}
      ];
      corners.forEach(({cx, cz}) => {
        for (let dx = -3; dx <= 3; dx++) {
          for (let dz = -3; dz <= 3; dz++) {
            for (let dy = 1; dy <= 4; dy++) {
              const isWall = Math.abs(dx) === 3 || Math.abs(dz) === 3;
              if (isWall) serv.setBlock(serv.overworld, { x: cx + dx, y: y + dy, z: cz + dz }, 5, 0); // Wood
              if (dy === 4) serv.setBlock(serv.overworld, { x: cx + dx, y: y + dy, z: cz + dz }, 17, 0); // Log roof
            }
          }
        }
      });

      console.log('Spawn Town Generated.');
    };

    // --- Player Join Logic (Items, Border, Interactions) ---
    serv.on('playerJoined', (player: any) => {
      // Teleport to spawn
      player.teleport({ x: 0, y: 61, z: 0 });
      
      // Give Recipe Book on spawn
      player.inventory.addItem(340, 1); // Book
      player.chat('§6§lWELCOME > §fYou received a §eCrafting Recipe Book§f!');

      // Border Enforcement
      player.on('position', (pos: any) => {
        playerPositions.set(player.username, { x: pos.x, y: pos.y, z: pos.z });
        if (Math.abs(pos.x) > BORDER_HALF || Math.abs(pos.z) > BORDER_HALF) {
          const newX = Math.max(-BORDER_HALF, Math.min(BORDER_HALF, pos.x));
          const newZ = Math.max(-BORDER_HALF, Math.min(BORDER_HALF, pos.z));
          player.teleport({ x: newX, y: pos.y, z: newZ });
          player.chat('§c§lBORDER > §fYou have reached the world border!');
        }
      });

      // Nether Star Recovery
      player.on('use_item', () => {
        const heldItem = player.inventory.slots[player.heldItemSlot + 36];
        if (heldItem && (heldItem.name === 'nether_star' || heldItem.type === 399)) {
          heldItem.count -= 1;
          if (heldItem.count <= 0) {
            player.inventory.updateSlot(player.heldItemSlot + 36, null);
          } else {
            player.inventory.updateSlot(player.heldItemSlot + 36, heldItem);
          }
          player.maxHealth = (player.maxHealth || 20) + 2;
          player.health = player.maxHealth;
          player.chat('§d§lRECOVERY > §fYou used a §eNether Star§f to gain a heart!');
        }
      });

      // Handle Loot Chest Opening (Right-Click)
      player.on('use_block', (pos: any) => {
        const posKey = `${pos.x},${pos.y},${pos.z}`;
        if (lootChests.has(posKey)) {
          const lootType = lootChests.get(posKey);
          if (lootType) {
            handleLoot(player, posKey, lootType);
          }
        }
      });

      player.on('place_block', (pos: any) => {
        if (isAtSpawn(pos)) {
          player.chat('§c§lSPAWN > §fYou cannot place blocks in the spawn town!');
          // Set to air to "cancel" placement
          setTimeout(() => {
            serv.setBlock(serv.overworld, pos, 0, 0);
          }, 10);
        }
      });

      player.on('end', () => {
        playerPositions.delete(player.username);
      });
    });

    // Broadcast positions to relay clients every 500ms for proximity chat
    setInterval(() => {
      const positions = Object.fromEntries(playerPositions);
      const message = JSON.stringify({ type: 'positions', data: positions });
      relayClients.forEach((client) => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }, 500);

    const handleLoot = (player: any, posKey: string, lootType: string) => {
      lootChests.delete(posKey);
      
      if (lootType === 'ruin') {
        const loot = [
          { id: 264, name: 'diamond', count: 1 },
          { id: 265, name: 'iron_ingot', count: 3 },
          { id: 322, name: 'golden_apple', count: 1 },
          { id: 399, name: 'nether_star', count: 1, chance: 0.02 },
          { id: 306, name: 'iron_helmet', count: 1, chance: 0.2 },
          { id: 307, name: 'iron_chestplate', count: 1, chance: 0.2 }
        ];
        player.chat('§6§lLOOT > §fYou opened a hidden chest!');
        loot.forEach(item => {
          if (!item.chance || Math.random() < item.chance) {
            player.inventory.addItem(item.id, item.count, (item as any).metadata || 0);
            player.chat(`§7+ ${item.count}x ${item.name.replace('_', ' ')}`);
          }
        });
      } else if (lootType === 'dungeon_legendary') {
        const diamondArmor = [
          { id: 310, name: 'diamond_helmet' },
          { id: 311, name: 'diamond_chestplate' },
          { id: 312, name: 'diamond_leggings' },
          { id: 313, name: 'diamond_boots' }
        ];
        const selectedArmor = diamondArmor[Math.floor(Math.random() * diamondArmor.length)];
        
        const loot = [
          { id: 264, name: 'diamond', count: 3 },
          { id: 322, name: 'enchanted_golden_apple', count: 2, metadata: 1 },
          { id: 399, name: 'nether_star', count: 1, chance: 0.05 },
          { id: selectedArmor.id, name: selectedArmor.name, count: 1 },
          { id: 265, name: 'iron_ingot', count: 8 },
          { id: 266, name: 'gold_ingot', count: 4 }
        ];
        player.chat('§b§lLEGENDARY LOOT > §fYou opened a Legendary Chest!');
        loot.forEach(item => {
          if (!item.chance || Math.random() < item.chance) {
            player.inventory.addItem(item.id, item.count, (item as any).metadata || 0);
            player.chat(`§b+ ${item.count}x ${item.name.replace('_', ' ')}`);
          }
        });
      } else if (lootType === 'kingdom') {
        const loot = [
          { id: 297, name: 'bread', count: 5 },
          { id: 265, name: 'iron_ingot', count: 2 },
          { id: 266, name: 'gold_ingot', count: 1 },
          { id: 302, name: 'chainmail_helmet', count: 1, chance: 0.1 },
          { id: 303, name: 'chainmail_chestplate', count: 1, chance: 0.1 },
          { id: 314, name: 'gold_helmet', count: 1, chance: 0.15 },
          { id: 399, name: 'nether_star', count: 1, chance: 0.01 }
        ];
        player.chat('§e§lVILLAGE LOOT > §fYou found village supplies!');
        loot.forEach(item => {
          if (!item.chance || Math.random() < item.chance) {
            player.inventory.addItem(item.id, item.count, (item as any).metadata || 0);
            player.chat(`§e+ ${item.count}x ${item.name.replace('_', ' ')}`);
          }
        });
      }
    };

    // --- Custom Ruins & Dungeons Generation ---
    const spawnedStructures = new Set<string>();
    const lootChests = new Map<string, string>(); // "x,y,z" -> "ruin" | "dungeon" | "kingdom"
    
    const generateRuin = (x: number, z: number) => {
      const chunkKey = `${Math.floor(x/16)},${Math.floor(z/16)}`;
      if (spawnedStructures.has(chunkKey)) return;
      spawnedStructures.add(chunkKey);

      const y = 60;
      for (let dx = -2; dx <= 2; dx++) {
        for (let dz = -2; dz <= 2; dz++) {
          for (let dy = 0; dy < 4; dy++) {
            const isWall = Math.abs(dx) === 2 || Math.abs(dz) === 2;
            const isRoof = dy === 3;
            const isFloor = dy === 0;
            if (isFloor) serv.setBlock(serv.overworld, { x: x + dx, y: y + dy, z: z + dz }, 98, 0);
            else if (isWall && Math.random() > 0.2) serv.setBlock(serv.overworld, { x: x + dx, y: y + dy, z: z + dz }, 98, 0);
            else if (isRoof && Math.random() > 0.4) serv.setBlock(serv.overworld, { x: x + dx, y: y + dy, z: z + dz }, 44, 5);
          }
        }
      }
      serv.setBlock(serv.overworld, { x: x, y: y + 1, z: z }, 54, 0); // Chest
      lootChests.set(`${x},${y+1},${z}`, 'ruin');
      console.log(`Spawned ruin at ${x}, ${z}`);
    };

    const generateDungeon = (x: number, z: number) => {
      const chunkKey = `${Math.floor(x/16)},${Math.floor(z/16)}`;
      if (spawnedStructures.has(chunkKey)) return;
      spawnedStructures.add(chunkKey);

      const y = 55;
      const size = 4;
      
      for (let dx = -size; dx <= size; dx++) {
        for (let dz = -size; dz <= size; dz++) {
          for (let dy = 0; dy < 6; dy++) {
            const isWall = Math.abs(dx) === size || Math.abs(dz) === size;
            const isRoof = dy === 5;
            const isFloor = dy === 0;
            const blockType = Math.random() > 0.3 ? 98 : 48;
            
            if (isFloor) serv.setBlock(serv.overworld, { x: x + dx, y: y + dy, z: z + dz }, blockType, 0);
            else if (isWall) {
              if (dy === 2 && (dx === 0 || dz === 0)) continue;
              serv.setBlock(serv.overworld, { x: x + dx, y: y + dy, z: z + dz }, blockType, 0);
            } else if (isRoof) serv.setBlock(serv.overworld, { x: x + dx, y: y + dy, z: z + dz }, blockType, 0);
          }
        }
      }

      serv.setBlock(serv.overworld, { x: x - 2, y: y + 1, z: z - 2 }, 98, 0);
      serv.setBlock(serv.overworld, { x: x + 2, y: y + 1, z: z - 2 }, 98, 0);
      serv.setBlock(serv.overworld, { x: x - 2, y: y + 1, z: z + 2 }, 98, 0);
      serv.setBlock(serv.overworld, { x: x + 2, y: y + 1, z: z + 2 }, 98, 0);

      // Legendary Chest in center
      serv.setBlock(serv.overworld, { x: x, y: y + 1, z: z }, 54, 0);
      lootChests.set(`${x},${y+1},${z}`, 'dungeon_legendary');
      
      // Secondary Chests
      serv.setBlock(serv.overworld, { x: x - 3, y: y + 1, z: z - 3 }, 54, 0);
      lootChests.set(`${x-3},${y+1},${z-3}`, 'ruin');
      serv.setBlock(serv.overworld, { x: x + 3, y: y + 1, z: z + 3 }, 54, 0);
      lootChests.set(`${x+3},${y+1},${z+3}`, 'ruin');
      
      serv.broadcast('§5§lDUNGEON > §fA massive dungeon has been discovered nearby!');
      console.log(`Spawned dungeon at ${x}, ${z}`);
    };

    const generateKingdom = (x: number, z: number) => {
      const chunkKey = `${Math.floor(x/16)},${Math.floor(z/16)}`;
      if (spawnedStructures.has(chunkKey)) return;
      spawnedStructures.add(chunkKey);

      const y = 60;
      const houseOffsets = [{dx: -8, dz: -8}, {dx: 8, dz: -8}, {dx: 0, dz: 8}];
      
      houseOffsets.forEach(offset => {
        const hx = x + offset.dx;
        const hz = z + offset.dz;
        
        for (let dx = -2; dx <= 2; dx++) {
          for (let dz = -2; dz <= 2; dz++) {
            for (let dy = 0; dy < 4; dy++) {
              const isWall = Math.abs(dx) === 2 || Math.abs(dz) === 2;
              const isRoof = dy === 3;
              const isFloor = dy === 0;
              if (isFloor) serv.setBlock(serv.overworld, { x: hx + dx, y: y + dy, z: hz + dz }, 5, 0);
              else if (isWall) serv.setBlock(serv.overworld, { x: hx + dx, y: y + dy, z: hz + dz }, 5, 0);
              else if (isRoof) serv.setBlock(serv.overworld, { x: hx + dx, y: y + dy, z: hz + dz }, 17, 0);
            }
          }
        }
        // Village Chest
        serv.setBlock(serv.overworld, { x: hx, y: y + 1, z: hz }, 54, 0);
        lootChests.set(`${hx},${y+1},${hz}`, 'kingdom');
      });

      serv.broadcast('§e§lKINGDOM > §fA small kingdom village has been spotted!');
      console.log(`Spawned kingdom at ${x}, ${z}`);
    };

    // Periodically check for players and spawn structures nearby
    setInterval(() => {
      serv.players.forEach((player: any) => {
        const rand = Math.random();
        if (rand < 0.005) { // 0.5% chance for Kingdom
          const rx = player.position.x + (Math.random() - 0.5) * 300;
          const rz = player.position.z + (Math.random() - 0.5) * 300;
          generateKingdom(Math.floor(rx), Math.floor(rz));
        } else if (rand < 0.01) { // 1% chance for Dungeon
          const rx = player.position.x + (Math.random() - 0.5) * 200;
          const rz = player.position.z + (Math.random() - 0.5) * 200;
          generateDungeon(Math.floor(rx), Math.floor(rz));
        } else if (rand < 0.06) { // 5% chance for Ruin
          const rx = player.position.x + (Math.random() - 0.5) * 100;
          const rz = player.position.z + (Math.random() - 0.5) * 100;
          generateRuin(Math.floor(rx), Math.floor(rz));
        }
      });
    }, 15000);

    // Handle Loot Cache breaking
    serv.on('blockBreak', ({ player, position, block }: any) => {
      if (isAtSpawn(position)) {
        player.chat('§c§lSPAWN > §fYou cannot break blocks in the spawn town!');
        // Set block back to "cancel" break
        setTimeout(() => {
          serv.setBlock(serv.overworld, position, block.type, block.metadata);
        }, 10);
        return;
      }

      const posKey = `${position.x},${position.y},${position.z}`;
      const lootType = lootChests.get(posKey);

      if (block.type === 54 && lootType) { // Chest
        handleLoot(player, posKey, lootType);
      }
    });
    // Generate Spawn Town on first run
    generateSpawnTown();
    serv.setSpawnPoint({ x: 0, y: 61, z: 0 });
  };

  console.log('Starting Minecraft server on port', MC_PORT);
  const serverInstance = mcServer.createMCServer({
    port: MC_PORT,
    'max-players': 100,
    motd: 'Eaglercraft Survival LifeSteal',
    'game-mode': 0, // Survival
    difficulty: 2, // Normal
    worldFolder: 'world',
    logging: true,
    'online-mode': false,
    host: '0.0.0.0',
    generation: {
      name: 'diamond_square',
      options: {
        worldHeight: 80
      }
    },
    kickTimeout: 10000,
    plugins: {
      custom: customPlugin
    },
    modpe: false,
    'view-distance': 10,
    'player-list-text': {
      header: 'Welcome to Eaglercraft Survival!',
      footer: 'LifeSteal Plugin Enabled'
    },
    'everybody-op': true,
    'spawn-point': { x: 0, y: 61, z: 0 },
    version: '1.8.8'
  });

  // Handle WebSocket Upgrades
  server.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

    if (pathname === '/relay') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleRelayConnection(ws);
      });
    } else {
      wss.handleUpgrade(request, socket, head, (ws) => {
        handleServerConnection(ws);
      });
    }
  });

  function handleRelayConnection(ws: any) {
    ws.id = Math.random().toString(36).substring(7);
    ws.room = 'global';
    relayClients.add(ws);
    console.log(`Relay client ${ws.id} connected to room ${ws.room}`);

    ws.on('message', (data: any) => {
      try {
        const msg = JSON.parse(data.toString());
        
        if (msg.type === 'join') {
          ws.room = msg.room || 'global';
          ws.username = msg.username;
          console.log(`Client ${ws.id} (${ws.username}) joined room ${ws.room}`);
          return;
        }

        // Broadcast to others in the same room
        relayClients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN && client.room === ws.room) {
            client.send(data);
          }
        });
      } catch (e) {
        // Fallback for non-JSON Eaglercraft signaling
        relayClients.forEach((client) => {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(data);
          }
        });
      }
    });

    ws.on('close', () => {
      relayClients.delete(ws);
      console.log('Relay client disconnected. Total:', relayClients.size);
    });

    ws.on('error', (err) => {
      console.error('Relay WS Error:', err);
      relayClients.delete(ws);
    });
  }

  function handleServerConnection(ws: WebSocket) {
    console.log('New Eaglercraft server connection');

    const client = new net.Socket();
    client.connect(MC_PORT, '127.0.0.1', () => {
      console.log('Connected to internal MC server');
    });

    client.on('data', (data) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(data);
      }
    });

    ws.on('message', (message: Buffer) => {
      client.write(message);
    });

    client.on('close', () => {
      ws.close();
    });

    ws.on('close', () => {
      client.destroy();
    });

    client.on('error', (err) => {
      console.error('MC Client Error:', err);
      ws.close();
    });

    ws.on('error', (err) => {
      console.error('WS Error:', err);
      client.destroy();
    });
  }

  // 3. Vite Middleware for Frontend
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), 'dist')));
    app.get('*', (req, res) => {
      res.sendFile(path.join(process.cwd(), 'dist', 'index.html'));
    });
  }

  const PORT = 3000;
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Eaglercraft Server running at http://localhost:${PORT}`);
    console.log(`WebSocket Proxy active on the same port.`);
  });
}

startServer().catch(console.error);
