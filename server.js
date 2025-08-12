// server.js
import './worker.js'
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient } = require("redis");

const PORT = process.env.PORT || 3000;
const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

async function main() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: "*" }
  });

  // Simple page to test realtime
  app.get("/", (_, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`
<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Job Alerts</title></head>
  <body>
    <h2>Realtime Job Alerts</h2>
    <p>Connected as <b>user: demo</b></p>
    <ul id="feed"></ul>
    <script src="/socket.io/socket.io.js"></script>
    <script>
      const socket = io("/", { auth: { userId: "demo" } });
      socket.on("connect", () => console.log("connected", socket.id));
      socket.on("job_notification", (msg) => {
        const li = document.createElement("li");
        li.textContent = JSON.stringify(msg);
        document.getElementById("feed").appendChild(li);
      });
    </script>
  </body>
</html>
    `);
  });

  app.get("/health", (_, res) => res.json({ ok: true }));

  // Map sockets to a user room
  io.on("connection", (socket) => {
    const userId = (socket.handshake.auth && socket.handshake.auth.userId) || "demo";
    socket.join(`user:${userId}`);
  });

  // Redis pub/sub: pSubscribe to notifications:<userId>
  const sub = createClient({ url: REDIS_URL });
  sub.on("error", (e) => console.error("Redis sub error:", e));
  await sub.connect();
  await sub.pSubscribe("notifications:*", (message, channel) => {
    try {
      const payload = JSON.parse(message);
      const userRoom = `user:${channel.split(":")[1]}`; // "notifications:<userId>"
      // Emit to that user's room
      io.to(userRoom).emit("job_notification", payload);
    } catch (e) {
      console.error("Failed to handle message:", e);
    }
  });

  server.listen(PORT, () => {
    console.log(`Web server listening on http://localhost:${PORT}`);
  });

  // Graceful shutdown
  process.on("SIGINT", async () => {
    try { await sub.quit(); } catch {}
    process.exit(0);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
