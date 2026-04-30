import { DateTime } from "luxon";
import sanitizeHtml from "sanitize-html";
import fs from "fs/promises";
import path from "path";
import { log } from "console";
//import { connectMongo } from "../config/mongo.js";
import prisma from "../config/prisma.js";
import {
  handleAcceptChat,
  finalizeChatSession,
  processNextChat,
  handleRejectChat,
  updateQueuePositions,
} from "../services/chatService.js";

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

async function socketHandler(io, pubClient, subClient, redisClient) {
  try {
    const channels = [
      "chat_status",
      "messages",
      "room_notification",
      "astrologer_typing",
      "end_chat_by_astrologer",
      "astrologer_disconnected",
      "queue_update",
    ];

    for (const channel of channels) {
      await subClient.pSubscribe(channel, async (message, ch) => {
        try {
          logEvent(`Redis:${ch}`, message);
          const data = JSON.parse(message);

          switch (ch) {
            case "chat_status":
              if (data.status === "Accepted") {
                try {
                  const result = await handleAcceptChat(
                    data.roomid,
                    prisma,
                    redisClient,
                    pubClient,
                  );
                  if (result) {
                    io.emit("chatAcceptedByAstrologer", data);
                  }
                } catch (err) {
                  logEvent("ChatAcceptError", err.stack, true);
                }
              }
              if (data.status === "rejected") {
                await handleRejectChat(
                  data.roomid,
                  prisma,
                  redisClient,
                  pubClient,
                );
                // io.emit("chat_rejected_astrologer", data);
                io.emit("chat_rejected", data);
              }
              break;

            case "messages":
              if (data.sender === "Astrologer") {
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
                  await redisClient.rPush(
                    `chat_messages:${data.room_id}`,
                    JSON.stringify(formattedMessage),
                  );
                } catch (err) {
                  logEvent("MessageEmitError", err.stack, true);
                }

                io.to(data.room_id).emit("receive_message", data);
              }
              break;

            case "room_notification":
              io.to(data.roomid).emit("roomNotification", data);
              break;

            case "astrologer_typing":
              io.to(data.roomid).emit("typing", data);
              break;
            case "queue_update":
              io.to(data.roomId).emit("queue_position", data);
              break;

            case "end_chat_by_astrologer":
              io.to(data.roomId).emit("leave_chat", data);
              await finalizeChatSession(
                data.roomId,
                prisma,
                redisClient,
                data.astroId,
              );

              //------DELETE KEY AFTER ASTRLOGER CHAT END--------
                let queueKey = `chat_queue:${data.astroId}`;
                const queueList = await redisClient.lRange(queueKey, 0, -1);
                console.log("Queue list before removing item:", queueList);

                let itemToRemove = null;

                for (const item of queueList) {
                const parsed = JSON.parse(item);

                if (parsed.roomId === data.roomId) {
                itemToRemove = item;
                break;
                }
                }

                if (itemToRemove) {
                  console.log("Item to remove from queueccccccccc:", itemToRemove);
                const check =await redisClient.lRem(queueKey, 1, itemToRemove);
                if(check){
                  console.log("Item removed from queue successfully after astrologer ended chat");
                  await updateQueuePositions(queueKey, redisClient, pubClient);
                }
                }
              //-------END CODE FOR DELETE KEY AFTER ASTRLOGER CHAT END-------
              
              
              setTimeout(async () => {
                try {
                  
                  const queueLength = await pubClient.lLen(queueKey);
                  if (queueLength > 0) {
                    await processNextChat(data.astroId, redisClient, pubClient);
                  }
                } catch (err) {
                  console.error("Delayed processNextChat errorAAAAAAAAA:", err);
                }
              }, 8000);

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

      onSafe("chat_request", async (data) => {
        try {
          const astroId = data.astro_id;
          const queueKey = `chat_queue:${astroId}`;
          const roomId = data.room_id;
          socket.join(String(roomId));
          socket.roomId = String(roomId);

          // Get current queue length
          const queueLength = await pubClient.lLen(queueKey);
          if (queueLength == 0) return;

          const currentRoomId = await pubClient.get(`current_chat:${astroId}`);
          //  If user is NOT first → send queue position
          const queueList = await pubClient.lRange(queueKey, 0, -1);
          let waitTime = 0;
          // Sum max time of all users before current user
          for (let i = 0; i < queueList.length; i++) {
            console.log("Queue lengthhhhhhhhhhhhhhhhh:", queueList.length);
            const user = JSON.parse(queueList[i]);
            // stop when current user reached
            if (user.roomId === roomId) break;
            console.log(
              "User in queue MAXTTTTTTTTTTTTTTIME:",
              user.userName,
              "Max time:",
              user.maximum_time,
            );
            waitTime += user.maximum_time;
          }

          if (queueLength > 5) {
            socket.emit("queue_full", {
              message: "Astrologer is busy. Please try another astrologer.",
              status: "FULL",
            });

            return socket.emit("chat_rejected", {
              message: "Astrologer is busy. Please try another astrologer.",
              status: "FULL",
            });
          }
          // If first user → send to astrologer
          const exists = await pubClient.exists(`current_chat:${astroId}`);
          console.log(
            "Queue length:",
            queueLength,
            "Current chat exists:",
            exists,
          );

          if (queueLength === 1 && !exists) {
            await pubClient.set(
              `first_chat_time:${astroId}`,
              data.maximum_time,
            );

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
              room_id: roomId,
              maximum_time: data.maximum_time,
              user_image: data.user_image,
            });
          } else {
            console.log(
              `User is in queue. Position: ${queueLength}, Estimated wait time: ${waitTime} minutes`,
            );
            const firstChatTime = await pubClient.get(
              `first_chat_time:${astroId}`,
            );
            socket.emit("queue_position", {
              message: `You are in queue`,
              position: exists === 1 ? queueLength : queueLength - 1,
              waitTime: exists === 1 ? firstChatTime * 60 : waitTime * 60,
              active: exists === 1 ? true : false,
            });
          }
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
            JSON.stringify(formattedMessage),
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

      socket.on("chatCompleted", async (data) => {
        try {
          const roomId = data.room_id;
          await finalizeChatSession(roomId, prisma, redisClient, data.astroId);

          socket.emit("chatCompleted", {
            message: `You have left the ${roomId} chat.`,
            roomId: roomId,
            status: "leave",
          });
          socket.leave(roomId);

          pubClient.publish(
            "end_chat_by_user",
            JSON.stringify({
              message: `User has left the ${roomId} chat.`,
              roomId: roomId,
              status: "leave",
            }),
          );
          let astroId = data.astroId;
          const currentRoom = await pubClient.get(
            `current_chat:${data.astroId}`,
          );
          if (currentRoom) {
            await pubClient.del(`current_chat:${astroId}`);
          }
              //------DELETE KEY AFTER USER CHAT END--------
                let queueKey = `chat_queue:${data.astroId}`;
                const queueList = await pubClient.lRange(queueKey, 0, -1);

                let itemToRemove = null;

                for (const item of queueList) {
                const parsed = JSON.parse(item);

                if (parsed.roomId === data.roomId) {
                itemToRemove = item;
                break;
                }
                }

                if (itemToRemove) {
                const check = await pubClient.lRem(queueKey, 1, itemToRemove);
                if (check) {
                  console.log("Item removed from queue successfully");
                  await updateQueuePositions(queueKey, redisClient, pubClient);
                }
                }
              //-------END CODE FOR DELETE KEY AFTER USER CHAT END-------
           
          let queueLength = await pubClient.lLen(queueKey);
          if (queueLength > 0) {
            setTimeout(async () => {
              await processNextChat(astroId, redisClient, pubClient);
            }, 5000);
          }
        } catch (error) {
          console.error("chat complete error", error);
        }
      });

      onSafe("cancel_chat_request", async (data) => {
        await handleRejectChat(data.room_id, prisma, redisClient, pubClient);
        io.emit("chat_rejected", data);

        safePublish(pubClient, "chat_cancel_by_user", {
          roomId: data.room_id,
          astroid: data.astroid,
          user_id: data.user_id,
          message: "User has cancelled the chat request",
        });
      });

      onSafe("queue_cancel", async (data) => {
        await handleRejectChat(data.room_id, prisma, redisClient, pubClient);
        io.emit("chat_rejected", data);
        safePublish(pubClient, "chat_cancel_by_user", {
          roomId: data.room_id,
          astroid: data.astroid,
          user_id: data.user_id,
          message: "User has cancelled the chat request from queue",
        });
      });

      onSafe("autodisconnect", async (data) => {
        const roomId = String(data.room_id);
        const astroId = String(data.astroid);
        await handleRejectChat(roomId, prisma, redisClient, pubClient);

        try {
          if (roomId) {
            socket.broadcast.emit("chat_reject_auto", {
              message: `${roomId} has been automatically rejected after 1 minute.`,
              roomId: roomId,
              status: "reject",
            });
            socket.leave(roomId);
            safePublish(pubClient, "chat_reject_auto", {
              message: `${roomId} has been automatically rejected after 1 minute.`,
              roomId: roomId,
              status: "reject",
            });
          } else {
            console.log("Chat accepted or not enough time has passed.");
          }
        } catch (error) {
          console.error("Auto-disconnect error:", error);
        }
      });

      onSafe("customer_recharge", (data) => {
        socket
          .to(data.room_id)
          .emit("open_popup_astrologer", { roomId: data.room_id });
        safePublish(pubClient, "customer_recharge", { roomId: data.room_id });
      });

      onSafe("customer_recharge_completed", (data) => {
        socket
          .to(data.room_id)
          .emit("customer_recharge_completed", {
            roomId: data.room_id,
            duetime: data.due_time,
          });
        safePublish(pubClient, "customer_recharge_completed", {
          roomId: data.room_id,
          duetime: data.due_time,
        });
      });

      onSafe("customer_recharge_fail", (data) => {
        socket
          .to(data.room_id)
          .emit("customer_recharge_fail", { roomId: data.room_id });
        safePublish(pubClient, "customer_recharge_fail", {
          roomId: data.room_id,
        });
      });
      /* =========================
         Typing
      ========================= */

      onSafe("typing", (data) => {
        console.log("Typing event receivedjjjjjjjjjj:", data);
        socket.to(data.room_id).emit("typing", {
          typing: data.typing,
          user_name: data.user_name,
          roomid: data.room_id,
        });
        console.log("Typing event receivedHHHHHHHHHHHHHHHHHHHHHHHHHHHH:", data);
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
