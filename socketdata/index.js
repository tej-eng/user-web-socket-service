import { DateTime } from "luxon";
import sanitizeHtml from "sanitize-html";
import fs from "fs/promises";
import path from "path";
import { log } from "console";
//import { connectMongo } from "../config/mongo.js";
import prisma from "../config/prisma.js";
import { handleAcceptChat,finalizeChatSession } from "../services/chatService.js";

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

async function socketHandler(io, pubClient, subClient,redisClient) {
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
                try{
                  const result = await handleAcceptChat(
                  data.roomid,
                  prisma,
                  redisClient 
             );
                }catch(err){logEvent("ChatAcceptError", err.stack, true)}
               // io.emit("chat_started_astrolgoer", data);
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
              await finalizeChatSession(data.roomId, prisma, redisClient);
              // ✅ CALL NEXT CHAT
              await processNextChat(
                "156983",
                redisClient,
                pubClient
              );
              
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

      // onSafe("chat_request", async (data) => {
      //     //check if queuepostion is greater then 0 then only publish otherwise emit to user queue position
      //     const astroId=156983;
      //     safePublish(pubClient, "chat_requests", {
      //     message: "Chat request sent successfully",
      //     userName: sanitizeHtml(data.userName || ""),
      //     gender: data.gender,
      //     dateOfBirth: data.dateOfBirth,
      //     timeOfBirth: data.timeOfBirth,
      //     occupation: sanitizeHtml(data.occupation || ""),
      //     location: sanitizeHtml(data.location || ""),
      //     astro_id: astroId,
      //     user_id: data.user_id,
      //     is_promotional: data.is_promotional,
      //     room_id: data.room_id,
      //     maximum_time: data.maximum_time,
      //     user_image: data.user_image,
      //     phoneNumber: "",
      //   });
      // });


  onSafe("chat_request", async (data) => {
  try {
    const astroId = data.astro_id || 156983;
    const queueKey = `chat_queue:${astroId}`;
    const roomId = data.room_id;

    // Get current queue length
    const queueLength = await pubClient.lLen(queueKey);

    console.log("Queue Length:", queueLength);

    //  If queue full (LIMIT = 5)
    if (queueLength >= 5) {
      console.log("Queue full for astrologer:", astroId);
      return socket.emit("chat_rejected", {
        message: "Astrologer is busy. Please try another astrologer.",
        status: "FULL"
      });
    }

    //  Push into queue
    //await pubClient.rPush(queueKey, roomId);

    //  Calculate position (after push)
    //const position = queueLength + 1;

    //  If user is NOT first → send queue position
    if (queueLength > 1) {
      return socket.emit("queue_position", {
        message: `You are in queue`,
        position: queueLength
      });
    }
    console.log("User is first in queue, sending chat request to astrologer:", roomId);
    // If first user → send request to astrologer
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
      room_id: roomId,
      maximum_time: data.maximum_time,
      user_image: data.user_image,
      phoneNumber: "",
      position: queueLength
    });

  } catch (err) {
    console.error("chat_request error:", err);
  }
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


socket.on("send_message", async (data) => {
  try {
    const formattedMessage = {
      msg_id: data.msg_id || `${Date.now()}${Math.random()}`, 
      sender_id: data.sender_id,
      room_id: data.room_id,
      received_id: data.received_id,
      message: data.message,
      image: data.image || null,
      sender: data.sender,
      replyTo: data.replyTo || null,
      time: data.time || Date.now(),
    };

    // store in redis
    await redisClient.rPush(
      `chat_messages:${data.room_id}`,
      JSON.stringify(formattedMessage)
    );

    // publish
    safePublish(pubClient, "messages", formattedMessage);

  } catch (error) {
    console.error("Error sending message:", error);
  }
});

      /* =========================
         Chat Completed
      ========================= */

   socket.on("complted_chat", async (data) => {
  try {
    console.log("Chat completion requested for room:", data.room_id);
    const roomId = data.room_id;
   await finalizeChatSession(roomId, prisma, redisClient);
    console.log("Chat saved to DB & cleared from Redis:", roomId);
    // ✅ CALL NEXT CHAT
    await processNextChat(
      "156983", //astrologer id for testing
      redisClient,
      pubClient
    );

  } catch (error) {
    console.error("chat complete error", error);
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