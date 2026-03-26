import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";
import { createClient } from "redis";
import { createAdapter } from "@socket.io/redis-adapter";
import cors from "cors";
import socketHandler from "./socketdata/index.js";
import swaggerUi from "swagger-ui-express";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import fs from "fs/promises";
import path from "path";
import cookie from "cookie";

dotenv.config();

const FRONTEND_URL = "https://dhwaniastro.com";

const app = express();
const port = process.env.PORT || 8009;
const server = createServer(app);

/* ==============================
   CORS
============================== */
app.use(cors({
  origin: FRONTEND_URL,
  credentials: true
}));

/* ==============================
   SOCKET.IO CONFIG
============================== */
const io = new Server(server, {
  path: "/socket.io",
  cors: {
    origin: FRONTEND_URL,
    credentials: true
  }
});

/* ==============================
   REDIS CONFIG
============================== */

// 🔹 1. Pub/Sub (Socket.IO Adapter)
const pubClient = createClient({
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
  },
});

const subClient = pubClient.duplicate();

// 🔹 2. MAIN Redis Client (for queue, active chat, etc.)
const redisClient = createClient({
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
  },
});

//  Connect all
await pubClient.connect();
await subClient.connect();
await redisClient.connect();

console.log(" Redis Pub/Sub Connected");
console.log(" Redis Main Client Connected");

// Attach adapter
io.adapter(createAdapter(pubClient, subClient));

/* ==============================
   JWT AUTH MIDDLEWARE
============================== */
const jwtAuthMiddleware = (socket, next) => {
  try {
    const cookieHeader = socket.handshake.headers.cookie;

    if (!cookieHeader) {
      return next(new Error("Authentication error: No cookies found"));
    }

    const cookies = cookie.parse(cookieHeader);
    const token = cookies.accessToken;

    if (!token) {
      return next(new Error("Authentication error: Token missing"));
    }

    jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
      if (err) {
        return next(new Error("Authentication error: Invalid token"));
      }

      socket.user = decoded;
      next();
    });

  } catch (err) {
    next(new Error("Authentication error"));
  }
};

/* ==============================
   NAMESPACE
============================== */
const dhwaniNamespace = io.of("/dhwani-astro");
dhwaniNamespace.use(jwtAuthMiddleware);

//  PASS redisClient here (IMPORTANT FIX)
socketHandler(dhwaniNamespace, pubClient, subClient, redisClient);

/* ==============================
   EXPRESS ROUTES
============================== */

app.use("/uploads", express.static(process.env.UPLOADS_DIR));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/", (req, res) => {
  res.send("Chat Service Running ");
});

// Logs API
app.get("/api/logs", async (req, res) => {
  try {
    const logFile = path.join(process.cwd(), "logs", "log.txt");
    const logs = await fs.readFile(logFile, "utf8");
    res.type("text/plain").send(logs);
  } catch (err) {
    if (err.code === "ENOENT") {
      res.status(404).json({ error: "Log file not found" });
    } else {
      console.error(err);
      res.status(500).json({ error: "Failed to read logs" });
    }
  }
});

/* ==============================
   START SERVER
============================== */
server.listen(port, () => {
  console.log(`Socket Server running on port ${port}`);
});