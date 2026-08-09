const express = require("express");
const http = require("http");
const WebSocket = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.get("/", (req, res) => {
  res.send("Multiplayer server online!");
});

wss.on("connection", (socket) => {
  console.log("Player connected");

  socket.send(JSON.stringify({
    type: "CONNECTED",
    message: "Connected to multiplayer server"
  }));

  socket.on("close", () => {
    console.log("Player disconnected");
  });
});

const PORT = process.env.PORT || 10000;

server.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});
