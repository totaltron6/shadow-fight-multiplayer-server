const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map();

// Sessões desconectadas ficam reservadas temporariamente
const disconnectedSessions = new Map();

const RECONNECT_TIMEOUT = 120000; // 2 minutos

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

function generateSessionId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).substring(2, 10)
  );
}

function send(socket, data) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(data));
  }
}

function broadcastRoom(room, data, exceptPlayer = null) {
  room.players.forEach((player) => {
    if (player !== exceptPlayer) {
      send(player.socket, data);
    }
  });
}

function resetRematchState(room) {
  room.rematch = {
    player1Ready: false,
    player2Ready: false
  };

  room.players.forEach((player) => {
    player.rematchReady = false;
  });
}

function createPlayerSession(player) {
  if (!player.sessionId) {
    player.sessionId = generateSessionId();
  }

  return player.sessionId;
}

function reserveDisconnectedPlayer(player) {
  if (!player.roomCode || !player.sessionId) return;

  const room = rooms.get(player.roomCode);

  if (!room) return;

  player.disconnected = true;

  const session = {
    sessionId: player.sessionId,
    roomCode: player.roomCode,
    playerNumber: player.playerNumber,
    room,
    player,
    expiresAt: Date.now() + RECONNECT_TIMEOUT
  };

  disconnectedSessions.set(player.sessionId, session);

  console.log(
    `Player ${player.playerNumber} disconnected from room ${room.code}`
  );

  broadcastRoom(
    room,
    {
      type: "OPPONENT_LEFT",
      message: "Opponent disconnected",
      player: player.playerNumber
    },
    player
  );

  setTimeout(() => {
    const savedSession = disconnectedSessions.get(player.sessionId);

    if (!savedSession) return;

    if (Date.now() < savedSession.expiresAt) return;

    disconnectedSessions.delete(player.sessionId);

    const currentRoom = rooms.get(savedSession.roomCode);

    if (!currentRoom) return;

    const savedPlayer = savedSession.player;

    currentRoom.players = currentRoom.players.filter(
      (p) => p !== savedPlayer
    );

    if (currentRoom.players.length === 0) {
      rooms.delete(currentRoom.code);
    } else {
      currentRoom.status = "WAITING";

      broadcastRoom(currentRoom, {
        type: "OPPONENT_LEFT",
        message: "Opponent left permanently",
        players: currentRoom.players.length,
        status: currentRoom.status
      });
    }

    console.log(
      `Reconnect timeout expired for session ${savedSession.sessionId}`
    );
  }, RECONNECT_TIMEOUT + 1000);
}

function removePlayerFromRoom(player) {
  if (!player.roomCode) return;

  const room = rooms.get(player.roomCode);

  if (!room) return;

  if (player.sessionId) {
    disconnectedSessions.delete(player.sessionId);
  }

  room.players = room.players.filter((p) => p !== player);

  player.roomCode = null;
  player.playerNumber = null;
  player.rematchReady = false;
  player.disconnected = false;

  if (room.players.length === 0) {
    rooms.delete(room.code);
    return;
  }

  room.status = "WAITING";

  resetRematchState(room);

  broadcastRoom(room, {
    type: "OPPONENT_LEFT",
    message: "Opponent left the match",
    roomCode: room.code,
    players: room.players.length,
    status: room.status
  });
}

wss.on("connection", (socket) => {
  const player = {
    socket,
    roomCode: null,
    playerNumber: null,
    rematchReady: false,
    disconnected: false,
    sessionId: null
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
        players: [player],
        rematch: {
          player1Ready: false,
          player2Ready: false
        }
      };

      rooms.set(roomCode, room);

      player.roomCode = roomCode;
      player.playerNumber = 1;
      player.rematchReady = false;
      player.disconnected = false;

      createPlayerSession(player);

      send(socket, {
        type: "ROOM_CREATED",
        roomCode,
        player: 1,
        sessionId: player.sessionId,
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
      player.rematchReady = false;
      player.disconnected = false;

      createPlayerSession(player);

      room.players.push(player);
      room.status = "READY";

      resetRematchState(room);

      send(socket, {
        type: "ROOM_JOINED",
        roomCode,
        player: 2,
        sessionId: player.sessionId,
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

    // RECONNECT SESSION
    if (data.type === "RECONNECT_SESSION") {
      const sessionId = String(data.sessionId || "").trim();

      if (!sessionId) {
        send(socket, {
          type: "RECONNECT_FAILED",
          message: "Missing session ID"
        });
        return;
      }

      const savedSession = disconnectedSessions.get(sessionId);

      if (!savedSession) {
        send(socket, {
          type: "RECONNECT_FAILED",
          message: "Session expired or not found"
        });
        return;
      }

      if (Date.now() > savedSession.expiresAt) {
        disconnectedSessions.delete(sessionId);

        send(socket, {
          type: "RECONNECT_FAILED",
          message: "Session expired"
        });

        return;
      }

      const room = rooms.get(savedSession.roomCode);

      if (!room) {
        disconnectedSessions.delete(sessionId);

        send(socket, {
          type: "RECONNECT_FAILED",
          message: "Room no longer exists"
        });

        return;
      }

      const oldPlayer = savedSession.player;

      oldPlayer.socket = socket;
      oldPlayer.disconnected = false;

      const restoredPlayer = oldPlayer;

      const index = room.players.findIndex(
        (p) => p.sessionId === sessionId
      );

      if (index !== -1) {
        room.players[index] = restoredPlayer;
      }

      player.socket = socket;
      player.roomCode = room.code;
      player.playerNumber = savedSession.playerNumber;
      player.sessionId = sessionId;
      player.rematchReady = restoredPlayer.rematchReady || false;
      player.disconnected = false;

      room.players = room.players.map((p) => {
        if (p.sessionId === sessionId) {
          return player;
        }

        return p;
      });

      disconnectedSessions.delete(sessionId);

      send(socket, {
        type: "RECONNECT_SUCCESS",
        roomCode: room.code,
        player: player.playerNumber,
        sessionId: player.sessionId,
        status: room.status,
        players: room.players.length
      });

      broadcastRoom(
        room,
        {
          type: "OPPONENT_RECONNECTED",
          player: player.playerNumber,
          message: "Opponent reconnected"
        },
        player
      );

      console.log(
        `Player ${player.playerNumber} reconnected to room ${room.code}`
      );

      return;
    }

    // REMATCH REQUEST
    if (data.type === "REMATCH_REQUEST") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room || room.players.length !== 2) {
        send(socket, {
          type: "ERROR",
          message: "Two players are required for a rematch"
        });

        return;
      }

      if (player.playerNumber === 1) {
        room.rematch.player1Ready = true;
      }

      if (player.playerNumber === 2) {
        room.rematch.player2Ready = true;
      }

      player.rematchReady = true;

      broadcastRoom(room, {
        type: "REMATCH_UPDATE",
        player1Ready: room.rematch.player1Ready,
        player2Ready: room.rematch.player2Ready
      });

      if (
        room.rematch.player1Ready &&
        room.rematch.player2Ready
      ) {
        room.status = "READY";

        broadcastRoom(room, {
          type: "REMATCH_START",
          roomCode: room.code,
          status: "READY"
        });

        resetRematchState(room);
      }

      return;
    }

    // PLAYER LEAVE MATCH
    if (data.type === "PLAYER_LEAVE_MATCH") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      const opponent = room.players.find(
        (p) => p !== player
      );

      if (opponent) {
        send(opponent.socket, {
          type: "OPPONENT_LEFT",
          message: "Opponent left the match"
        });
      }

      room.status = "WAITING";

      resetRematchState(room);

      send(socket, {
        type: "LEFT_MATCH"
      });

      return;
    }

    // PLAYER STATE
    if (data.type === "PLAYER_STATE") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      room.players.forEach((otherPlayer) => {
        if (
          otherPlayer !== player &&
          !otherPlayer.disconnected
        ) {
          send(otherPlayer.socket, {
            ...data,
            player: player.playerNumber
          });
        }
      });

      return;
    }

    // PLAYER ATTACK
    if (data.type === "PLAYER_ATTACK") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      room.players.forEach((otherPlayer) => {
        if (
          otherPlayer !== player &&
          !otherPlayer.disconnected
        ) {
          send(otherPlayer.socket, {
            ...data,
            player: player.playerNumber
          });
        }
      });

      return;
    }

    // PLAYER DEFENSE
    if (data.type === "PLAYER_DEFENSE") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      room.players.forEach((otherPlayer) => {
        if (
          otherPlayer !== player &&
          !otherPlayer.disconnected
        ) {
          send(otherPlayer.socket, {
            ...data,
            player: player.playerNumber
          });
        }
      });

      return;
    }

    // PLAYER DODGE
    if (data.type === "PLAYER_DODGE") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      room.players.forEach((otherPlayer) => {
        if (
          otherPlayer !== player &&
          !otherPlayer.disconnected
        ) {
          send(otherPlayer.socket, {
            ...data,
            player: player.playerNumber
          });
        }
      });

      return;
    }

    // PLAYER MATCH RESULT
    if (data.type === "PLAYER_MATCH_RESULT") {
      if (!player.roomCode) return;

      const room = rooms.get(player.roomCode);

      if (!room) return;

      if (data.winner !== 1 && data.winner !== 2) return;
      if (data.loser !== 1 && data.loser !== 2) return;

      room.status = "FINISHED";

      broadcastRoom(room, {
        type: "PLAYER_MATCH_RESULT",
        winner: data.winner,
        loser: data.loser
      });

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
    if (!player.roomCode) {
      console.log("Player disconnected without room");
      return;
    }

    reserveDisconnectedPlayer(player);
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
