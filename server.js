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

function broadcastRoom(room, data) {
  room.players.forEach((player) => {
    send(player.socket, data);
  });
}

function removePlayerFromRoom(player) {
  if (!player.roomCode) return;

  const room = rooms.get(player.roomCode);

  if (!room) return;

  room.players = room.players.filter((p) => p !== player);

  player.roomCode = null;

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  room.status = "WAITING";

  broadcastRoom(room, {
    type: "ROOM_UPDATE",
    roomCode: room.code,
    status: room.status,
    players: room.players.length
  });
}

wss.on("connection", (socket) => {
  const player = {
    socket,
    roomCode: null,
    playerNumber: null
  };

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

    // CREATE ROOM
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

    // JOIN ROOM
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

      // Tell Player 2 that the join was successful
      send(socket, {
        type: "ROOM_JOINED",
        roomCode,
        player: 2,
        status: room.status,
        players: 2
      });

      // Tell Player 1 that Player 2 joined
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

    // LEAVE ROOM
    if (data.type === "LEAVE_ROOM") {
      removePlayerFromRoom(player);

      send(socket, {
        type: "LEFT_ROOM"
      });

      return;
    }

    send(socket, {
      type: "ERROR",
      message: "Unknown message type"
    });
  });

  socket.on("close", () => {
    console.log("Player disconnected");
    removePlayerFromRoom(player);
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
