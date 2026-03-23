import { DateTime } from "luxon";
import sanitizeHtml from "sanitize-html";
import fs from "fs/promises";
import path from "path";
import { log } from "console";
import { connectMongo } from "../config/mongo.js";

/* =========================
   Socket State
========================= */

const sentRequests = {};
const requestCooldown = 1000;
const users = [];

/* =========================
   Logging
========================= */

async function logEvent(event, data, isError = false) {
  const ts = DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
  const logFn = isError ? console.error : console.log;

  const logMessage = `[${ts}] [${event}] ${
    typeof data === "object" ? JSON.stringify(data) : data
  }\n`;

  logFn(`[${ts}] [${event}]`, data);

  try {
    // const logDir = path.join(process.cwd(), 'logs');
    // await fs.mkdir(logDir, { recursive: true });
    // const logFile = path.join(logDir, 'log.txt');
    // await fs.appendFile(logFile, logMessage);
  } catch (err) {
    console.error("Failed to write to log file:", err);
  }
}

/* =========================
   User Join Room
========================= */

function userJoinGroup(id, room_id) {
  const user = { id, room_id };
  users.push(user);
  return user;
}

/* =========================
   Safe Redis Publish
========================= */

function safePublish(pubClient, channel, payload) {
  try {
    pubClient.publish(channel, JSON.stringify(payload));
  } catch (err) {
    logEvent(`PublishError:${channel}`, err.message, true);
  }
}

/* =========================
   Safe Socket Emit
========================= */

function safeEmit(ioOrSocket, event, payload) {
  try {
    ioOrSocket.emit(event, payload);
  } catch (err) {
    logEvent(`EmitError:${event}`, err.message, true);
  }
}

/* =========================
   Socket Handler
========================= */

async function socketHandler(io, pubClient, subClient) {
  try {
    const channels = [
      "chat_status",
      "messages",
      "room_notification",
      "astrologer_typing",
      "end_chat_by_astrologer",
      "astrologer_disconnected",
    ];

    for (const channel of channels) {
      await subClient.pSubscribe(channel, async (message, ch) => {
        try {
          logEvent(`Redis:${ch}`, message);

          const data = JSON.parse(message);

          switch (ch) {
            case "chat_status":
              if (data.status === "Accepted") {
                io.emit("chat_started_astrolgoer", data);
                io.emit("chat_started_user", data);
              }

              if (data.status === "rejected") {
                io.emit("chat_rejected_astrolgoer", data);
                io.emit("chat_rejected", data);
              }
              break;

            case "messages":
              if (data.sender === "Astrologer") {
                io.to(data.room_id).emit("receive_message", data);
              }
              break;

            case "room_notification":
              io.to(data.roomid).emit("roomNotification", data);
              break;

            case "astrologer_typing":
              io.to(data.roomid).emit("typing", data);
              break;

            case "end_chat_by_astrologer":
              io.to(data.roomId).emit("leave_chat", data);
              break;

            case "astrologer_disconnected":
              io.to(data.roomId).emit("user_disconnected", data);
              break;
          }
        } catch (err) {
          logEvent(`RedisHandlerError:${ch}`, err.stack, true);
        }
      });
    }

    io.on("connection", (socket) => {
      logEvent("SocketConnected", socket.id);

      const onSafe = (event, handler) => {
        socket.on(event, async (...args) => {
          try {
            await handler(...args);
          } catch (err) {
            logEvent(`SocketError:${event}`, err.stack, true);
          }
        });
      };

      /* =========================
         Chat Request
      ========================= */

      onSafe("chat_request", async (data) => {
          const astroId=156983;
          safePublish(pubClient, "chat_requests", {
          message: "Chat request sent successfully",
          userName: sanitizeHtml(data.userName || ""),
          gender: data.gender,
          dateOfBirth: data.dateOfBirth,
          timeOfBirth: data.timeOfBirth,
          occupation: sanitizeHtml(data.occupation || ""),
          location: sanitizeHtml(data.location || ""),
          astro_id: astroId,
          user_id: data.user_id,
          is_promotional: data.is_promotional,
          room_id: data.room_id,
          maximum_time: data.maximum_time,
          user_image: data.user_image,
          phoneNumber: "",
        });
      });

      /* =========================
         Join Chat
      ========================= */

      onSafe("joinChat", (data) => {
        userJoinGroup(data.username, data.room_id);
        socket.join(String(data.room_id));
        socket.roomId = String(data.room_id);
        safePublish(pubClient, "userJoinedChat", {
          message: `${data.username} has joined the chat.`,
          roomid: String(data.room_id),
        });
      });

      /* =========================
         Send Message
      ========================= */

      // onSafe("send_message", async (data) => {
      //   console.log("Received message:", data); 
      //   const message = {
      //     senderId: data.sender_id,
      //     message: sanitizeHtml(data.message),
      //     time: Date.now(),
      //   };

      //   await pubClient.rPush(
      //     `chat_messages:${data.room_id}`,
      //     JSON.stringify(message)
      //   );

      //   safePublish(pubClient, "messages", {
      //     ...data,
      //     message,
      //   });

      // });


socket.on("send_message", (data) => {
  try {
    const formattedMessage = {
      msg_id: `${Date.now()}${Math.floor(Math.random() * 100000)}`, 
      sender_id: data.sender_id || null,  
      room_id: data.room_id,
      received_id: data.received_id || null, 
      message: data.message,               
      image: data.image || null,
      sender: data.sender,                 
      replyTo: data.replyTo || null,
      time: new Date().toLocaleTimeString("en-IN", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: true,
      }),
    };

    console.log("[Formatted Message]:", formattedMessage);
    safePublish(pubClient, "messages", JSON.stringify(formattedMessage));
   // io.to(data.room_id).emit("receive_message", formattedMessage);

  } catch (error) {
    console.error("Error sending message:", error);
  }
});

      /* =========================
         Chat Completed
      ========================= */

      socket.on("complted_chat", async (data) => {
        try {
          const roomId = data.room_id;

          const messages = await pubClient.lRange(
            `chat_messages:${roomId}`,
            0,
            -1
          );

          const parsedMessages = messages.map((m) => JSON.parse(m));

          const db = await connectMongo();

          await db.collection("chat_history").insertOne({
            roomId,
            messages: parsedMessages,
            endedAt: new Date(),
          });

          await pubClient.del(`chat_messages:${roomId}`);

          logEvent("chat_saved_to_mongodb", roomId);
        } catch (error) {
          logEvent("chat_save_error", error, true);
        }
      });
     
      /* =========================
         Typing
      ========================= */

      onSafe("typing", (data) => {
        socket.to(data.room_id).emit("typing", {
          typing: data.typing,
          user_name: data.user_name,
          roomid: data.room_id,
        });

        safePublish(pubClient, "user_typing", {
          typing: data.typing,
          user_name: data.user_name,
          roomid: data.room_id,
        });
      });
    });
  } catch (err) {
    logEvent("socketHandlerCritical", err.stack, true);
  }
}

export default socketHandler;