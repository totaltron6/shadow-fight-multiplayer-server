const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

app.get("/", (req, res) => {
  res.send("Multiplayer server online!");
});

function generateRoomCode() {
  let code;

  do {
    code = Math.floor(100000 + Math.random() * 900000).toString();
  } while (rooms.has(code));

  return code;
}

function send(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function broadcastRoom(room, data, excludeSocket = null) {
  room.players.forEach((player) => {
    if (player.socket !== excludeSocket) {
      send(player.socket, data);
    }
  });
}

function removePlayerFromRoom(player) {
  if (!player.roomCode) return;

  const room = rooms.get(player.roomCode);

  if (!room) {
    player.roomCode = null;
    player.playerNumber = null;
    return;
  }

  room.players = room.players.filter((p) => p !== player);

  player.roomCode = null;
  player.playerNumber = null;

  if (room.players.length === 0) {
    rooms.delete(room.code);
    console.log(`Room ${room.code} deleted`);
    return;
  }

  room.status = "WAITING";

  broadcastRoom(room, {
    type: "ROOM_UPDATE",
    roomCode: room.code,
    status: room.status,
    players: room.players.length
  });

  console.log(`Player left room ${room.code}`);
}

wss.on("connection", (socket) => {
  const player = {
    socket,
    roomCode: null,
    playerNumber: null
  };

  console.log("Player connected");

  send(socket, {
    type: "CONNECTED",
    message: "Connected to multiplayer server"
  });

  socket.on("message", (message) => {
    let data;

    try {
      data = JSON.parse(message.toString());
    } catch {
      send(socket, {
        type: "ERROR",
        message: "Invalid message"
      });
      return;
    }

    // ==========================================
    // CREATE ROOM
    // ==========================================

    if (data.type === "CREATE_ROOM") {
      if (player.roomCode) {
        send(socket, {
          type: "ERROR",
          message: "You are already in a room"
        });
        return;
      }

      const roomCode = generateRoomCode();

      const room = {
        code: roomCode,
        status: "WAITING",
        players: [player]
      };

      rooms.set(roomCode, room);

      player.roomCode = roomCode;
      player.playerNumber = 1;

      send(socket, {
        type: "ROOM_CREATED",
        roomCode,
        player: 1,
        status: "WAITING",
        players: 1
      });

      console.log(`Room ${roomCode} created`);

      return;
    }

    // ==========================================
    // JOIN ROOM
    // ==========================================

    if (data.type === "JOIN_ROOM") {
      const roomCode = String(data.roomCode || "").trim();
      const room = rooms.get(roomCode);

      if (!room) {
        send(socket, {
          type: "ROOM_NOT_FOUND",
          message: "Room not found"
        });
        return;
      }

      if (room.players.length >= 2) {
        send(socket, {
          type: "ROOM_FULL",
          message: "Room is full"
        });
        return;
      }

      if (player.roomCode) {
        send(socket, {
          type: "ERROR",
          message: "You are already in a room"
        });
        return;
      }

      player.roomCode = roomCode;
      player.playerNumber = 2;

      room.players.push(player);
      room.status = "READY";

      send(socket, {
        type: "ROOM_JOINED",
        roomCode,
        player: 2,
        status: room.status,
        players: 2
      });

      const player1 = room.players[0];

      send(player1.socket, {
        type: "ROOM_UPDATE",
        roomCode,
        status: room.status,
        players: 2
      });

      console.log(`Player 2 joined room ${roomCode}`);

      return;
    }

    // ==========================================
    // PLAYER MOVEMENT STATE
    // ==========================================

    if (data.type === "PLAYER_STATE") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      const otherPlayer = room.players.find(
        (p) => p !== player
      );

      if (!otherPlayer) return;

      const state = {
        type: "PLAYER_STATE",
        player: player.playerNumber,
        x: Number(data.x) || 0,
        y: Number(data.y) || 0,
        velocityX: Number(data.velocityX) || 0,
        velocityY: Number(data.velocityY) || 0,
        facing: data.facing === "left" ? "left" : "right",
        grounded: Boolean(data.grounded),
        crouching: Boolean(data.crouching),
        jumping: Boolean(data.jumping)
      };

      send(otherPlayer.socket, state);

      return;
    }

    // ==========================================
    // PLAYER ATTACK
    // ==========================================

    if (data.type === "PLAYER_ATTACK") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      const otherPlayer = room.players.find(
        (p) => p !== player
      );

      if (!otherPlayer) return;

      if (
        data.attack !== "punch" &&
        data.attack !== "kick"
      ) {
        return;
      }

      const attack = {
        type: "PLAYER_ATTACK",
        player: player.playerNumber,
        attack: data.attack,
        timestamp: Date.now()
      };

      send(otherPlayer.socket, attack);

      console.log(
        `Player ${player.playerNumber} used ${data.attack} in room ${room.code}`
      );

      return;
    }

    // ==========================================
    // PLAYER DEFENSE
    // ==========================================

    if (data.type === "PLAYER_DEFENSE") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      const otherPlayer = room.players.find(
        (p) => p !== player
      );

      if (!otherPlayer) return;

      if (
        data.action !== "start" &&
        data.action !== "stop"
      ) {
        return;
      }

      const defense = {
        type: "PLAYER_DEFENSE",
        player: player.playerNumber,
        action: data.action,
        timestamp: Date.now()
      };

      send(otherPlayer.socket, defense);

      console.log(
        `Player ${player.playerNumber} defense: ${data.action}`
      );

      return;
    }

    // ==========================================
    // PLAYER DODGE
    // ==========================================

    if (data.type === "PLAYER_DODGE") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      const otherPlayer = room.players.find(
        (p) => p !== player
      );

      if (!otherPlayer) return;

      if (
        data.direction !== "left" &&
        data.direction !== "right"
      ) {
        return;
      }

      const dodge = {
        type: "PLAYER_DODGE",
        player: player.playerNumber,
        direction: data.direction,
        timestamp: Date.now()
      };

      send(otherPlayer.socket, dodge);

      console.log(
        `Player ${player.playerNumber} dodged ${data.direction} in room ${room.code}`
      );

      return;
    }

    // ==========================================
    // LEAVE ROOM
    // ==========================================

    if (data.type === "LEAVE_ROOM") {
      removePlayerFromRoom(player);

      send(socket, {
        type: "LEFT_ROOM"
      });

      return;
    }

    // ==========================================
    // UNKNOWN MESSAGE
    // ==========================================

    send(socket, {
      type: "ERROR",
      message: "Unknown message type"
    });
  });

  // ==========================================
  // DISCONNECT
  // ==========================================

  socket.on("close", () => {
    console.log("Player disconnected");
    removePlayerFromRoom(player);
  });

  socket.on("error", (error) => {
    console.log("WebSocket error:", error.message);
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
