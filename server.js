// Paper Plane Party — game server
// Handles: lobby (public/private rooms, max 5 players), one-vote-per-round
// majority voting, and streaming the winning command to the ESP32-S3 plane.

const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8080;
const MIN_PLAYERS = 1; // rounds run as soon as at least 1 pilot has joined (solo test-flights allowed)
const MAX_PLAYERS = 5;
const ROUND_MS = 2000; // matches realistic servo response time
const VALID_COMMANDS = ["left", "right", "up", "down", "throttle_up", "throttle_down"];

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

/** rooms: Map<code, Room> */
const rooms = new Map();

function makeCode(len = 4) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no ambiguous chars
  let code;
  do {
    code = Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function createRoom(visibility, name) {
  const code = makeCode();
  const room = {
    code,
    name: name || `Room ${code}`,
    visibility, // 'public' | 'private'
    players: new Map(), // ws -> { id, name }
    plane: null, // ws of the connected ESP32-S3 client
    votes: new Map(), // ws -> command  (cleared each round; one vote locked per round)
    roundTimer: null,
    lastResult: null,
    lastCommand: null,
    createdAt: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function roomSummary(room) {
  return {
    code: room.code,
    name: room.name,
    visibility: room.visibility,
    playerCount: room.players.size,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
    planeConnected: !!room.plane,
  };
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const ws of room.players.keys()) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function sendPlaneStatus(room) {
  broadcast(room, { type: "room_state", ...publicRoomState(room) });
}

function publicRoomState(room) {
  return {
    code: room.code,
    name: room.name,
    visibility: room.visibility,
    players: Array.from(room.players.values()).map((p) => p.name),
    maxPlayers: MAX_PLAYERS,
    planeConnected: !!room.plane,
    lastCommand: room.lastCommand,
  };
}

function startRoundLoop(room) {
  if (room.roundTimer) return; // already running
  if (room.players.size < MIN_PLAYERS) return; // need at least MIN_PLAYERS to fly
  room.roundTimer = setInterval(() => tallyRound(room), ROUND_MS);
  broadcast(room, { type: "round_start", deadline: Date.now() + ROUND_MS, roundMs: ROUND_MS });
}

function stopRoundLoopIfEmpty(room) {
  if (room.players.size === 0 && room.roundTimer) {
    clearInterval(room.roundTimer);
    room.roundTimer = null;
  }
}

function tallyRound(room) {
  const tally = {};
  for (const cmd of room.votes.values()) {
    tally[cmd] = (tally[cmd] || 0) + 1;
  }

  let winner = null;
  let max = 0;
  let tiedAt = new Map(); // command -> first-cast timestamp order preserved by insertion
  // Determine winner; ties broken by earliest cast vote among tied commands.
  for (const [cmd, count] of Object.entries(tally)) {
    if (count > max) {
      max = count;
      winner = cmd;
    }
  }
  // Tie-break: if multiple commands share max count, pick whichever was cast first this round.
  const topCommands = Object.entries(tally).filter(([, c]) => c === max);
  if (topCommands.length > 1) {
    for (const [ws, cmd] of room.votes.entries()) {
      if (topCommands.some(([c]) => c === cmd)) {
        winner = cmd;
        break;
      }
    }
  }

  room.lastResult = { tally, winner, totalVotes: room.votes.size };
  room.lastCommand = winner || null;

  broadcast(room, {
    type: "round_result",
    tally,
    winner,
    totalVotes: room.votes.size,
    playerCount: room.players.size,
  });

  if (room.plane && room.plane.readyState === room.plane.OPEN && winner) {
    room.plane.send(JSON.stringify({ type: "command", command: winner }));
  }

  room.votes.clear();
  broadcast(room, { type: "round_start", deadline: Date.now() + ROUND_MS, roundMs: ROUND_MS });
}

wss.on("connection", (ws) => {
  ws.id = crypto.randomUUID();
  ws.roomCode = null;
  ws.isPlane = false;

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    switch (msg.type) {
      case "list_public": {
        const publicRooms = Array.from(rooms.values())
          .filter((r) => r.visibility === "public" && r.players.size < MAX_PLAYERS)
          .map(roomSummary);
        ws.send(JSON.stringify({ type: "public_rooms", rooms: publicRooms }));
        break;
      }

      case "create_room": {
        const visibility = msg.visibility === "private" ? "private" : "public";
        const room = createRoom(visibility, msg.name);
        joinRoom(ws, room, msg.playerName);
        break;
      }

      case "join_room": {
        const room = rooms.get((msg.code || "").toUpperCase());
        if (!room) {
          ws.send(JSON.stringify({ type: "error", message: "Room not found." }));
          return;
        }
        if (room.players.size >= MAX_PLAYERS) {
          ws.send(JSON.stringify({ type: "error", message: "Room is full (5/5)." }));
          return;
        }
        joinRoom(ws, room, msg.playerName);
        break;
      }

      case "register_plane": {
        const room = rooms.get((msg.code || "").toUpperCase());
        if (!room) {
          ws.send(JSON.stringify({ type: "error", message: "Room not found." }));
          return;
        }
        room.plane = ws;
        ws.isPlane = true;
        ws.roomCode = room.code;
        ws.send(JSON.stringify({ type: "plane_registered", code: room.code }));
        sendPlaneStatus(room);
        break;
      }

      case "vote": {
        const room = rooms.get(ws.roomCode);
        if (!room || !room.players.has(ws)) return;
        if (!VALID_COMMANDS.includes(msg.command)) return;
        // One command at a time: once locked in for this round, ignore further votes.
        if (room.votes.has(ws)) {
          ws.send(JSON.stringify({ type: "vote_rejected", reason: "already_voted" }));
          return;
        }
        room.votes.set(ws, msg.command);
        ws.send(JSON.stringify({ type: "vote_locked", command: msg.command }));
        broadcast(room, { type: "vote_progress", votesIn: room.votes.size, playerCount: room.players.size });
        break;
      }

      case "leave": {
        leaveRoom(ws);
        break;
      }

      default:
        break;
    }
  });

  ws.on("close", () => {
    if (ws.isPlane && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room && room.plane === ws) {
        room.plane = null;
        sendPlaneStatus(room);
      }
      return;
    }
    leaveRoom(ws);
  });
});

function joinRoom(ws, room, playerName) {
  const name = (playerName || `Pilot-${ws.id.slice(0, 4)}`).slice(0, 20);
  room.players.set(ws, { id: ws.id, name });
  ws.roomCode = room.code;

  ws.send(
    JSON.stringify({
      type: "joined_room",
      code: room.code,
      visibility: room.visibility,
      name: room.name,
      you: name,
    })
  );

  sendPlaneStatus(room);
  startRoundLoop(room);
}

function leaveRoom(ws) {
  const room = rooms.get(ws.roomCode);
  if (!room) return;
  room.players.delete(ws);
  room.votes.delete(ws);
  ws.roomCode = null;
  sendPlaneStatus(room);
  stopRoundLoopIfEmpty(room);
  if (room.players.size === 0 && !room.plane) {
    rooms.delete(room.code);
  }
}

server.listen(PORT, () => {
  console.log(`Paper Plane Party server running on port ${PORT}`);
});
