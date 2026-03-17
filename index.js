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
import fs from 'fs/promises';
import path from 'path';
import cookie from "cookie";

dotenv.config();

const app = express();
const port = process.env.PORT ;
const server = createServer(app);
app.use(cors({
  origin: "http://localhost:3000",
  credentials: true
}));

const io = new Server(server, {
  cors: {
    origin: "http://localhost:3000", 
    methods: ["GET", "POST"],
    credentials: true               
  },
});

// Redis connections
const pubClient = createClient({
  username: process.env.REDIS_USERNAME,
  password: process.env.REDIS_PASSWORD,
  socket: {
    host: process.env.REDIS_HOST,
    port: Number(process.env.REDIS_PORT),
  },
});

const subClient = pubClient.duplicate();

await pubClient.connect();
await subClient.connect();

io.adapter(createAdapter(pubClient, subClient));

/**
 * JWT authentication middleware for Socket.IO
 */
const jwtAuthMiddleware = (socket, next) => {

  console.log("JWT Auth Middleware Invoked");

  const cookieHeader = socket.handshake.headers.cookie;
  console.log("Received cookie header:", cookieHeader);

  if (!cookieHeader) {
    console.warn("No cookies found in handshake headers");
    return next(new Error("Authentication error: No cookies found"));
  }

  const cookies = cookie.parse(cookieHeader);
  console.log("Parsed cookies:", cookies);
  const token = cookies.accessToken;
  console.log("Extracted token from cookies:", token);

  if (!token) {
    console.warn("No accessToken found in cookies");
    return next(new Error("Authentication error: Token missing in cookies"));
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {

    if (err) {
      return next(new Error("Authentication error: Invalid token"));
    }

    socket.user = decoded;

    console.log("Authenticated socket user:", decoded);

    next();
  });
};

// Namespace for astrologer chat with JWT authentication
const dhwaniNamespace = io.of("/dhwani-astro");
dhwaniNamespace.use(jwtAuthMiddleware);

// Attach your socket handlers here
socketHandler(dhwaniNamespace, pubClient, subClient);

//app.use("/uploads", express.static("uploads"));
app.use("/uploads", express.static(process.env.UPLOADS_DIR));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

// Root endpoint
app.get("/", (req, res) => {
  res.send("Welcome to the Chat Application");
});

// Logs endpoint
app.get("/api/logs", async (req, res) => {
  try {
    const logFile = path.join(process.cwd(), 'logs', 'log.txt');
    const logs = await fs.readFile(logFile, 'utf8');
    res.type('text/plain').send(logs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      res.status(404).json({ error: 'Log file not found' });
    } else {
      console.error('Error reading log file:', err);
      res.status(500).json({ error: 'Failed to read log file' });
    }
  }
});

// Start server
server.listen(port, () => {
  console.log(`Server started on port ${port}`);
});
