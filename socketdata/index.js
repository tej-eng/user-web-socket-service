import { DateTime } from "luxon";
import sanitizeHtml from "sanitize-html";
import prisma from "../config/prisma.js";
import {
  handleAcceptChat,
  finalizeChatSession,
  processNextChat,
  handleRejectChat,
} from "../services/chatService.js";

/* =========================
   Logging
========================= */

function logEvent(event, data, isError = false) {
  const ts = DateTime.now().toFormat("yyyy-MM-dd HH:mm:ss");
  const logFn = isError ? console.error : console.log;
  logFn(`[${ts}] [${event}]`, data);
}

/* =========================
   Safe Helpers
========================= */

function safePublish(pubClient, channel, payload) {
  try {
    pubClient.publish(channel, JSON.stringify(payload));
  } catch (err) {
    logEvent(`PublishError:${channel}`, err.message, true);
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

    /* =========================
       REDIS SUBSCRIBER
    ========================= */

    for (const channel of channels) {
      await subClient.pSubscribe(channel, async (message, ch) => {
        try {
          const data = JSON.parse(message);

          switch (ch) {
            case "chat_status":
              if (data.status === "Accepted") {
                await handleAcceptChat(
                  data.roomid,
                  prisma,
                  redisClient,
                  pubClient
                );
                io.emit("chatAcceptedByAstrologer", data);
              }

              if (data.status === "rejected") {
                await handleRejectChat(
                  data.roomid,
                  prisma,
                  redisClient,
                  pubClient
                );
                io.emit("chat_rejected", data);
              }
              break;

            /* =========================
               ✅ FIXED MESSAGE HANDLER
            ========================= */
            case "messages":
              io.to(data.room_id).emit("receive_message", {
                ...data,

                // ALWAYS NORMALIZED
                message:
                  typeof data.message === "object"
                    ? data.message
                    : {
                        text: data.message,
                        time:
                          data.time || new Date().toISOString(),
                      },

                replyTo: data.replyTo || null,
              });
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
                data.astroId
              );

              setTimeout(async () => {
                let queueKey = `chat_queue:${data.astroId}`;
                const queueLength = await pubClient.lLen(queueKey);

                if (queueLength > 0) {
                  await processNextChat(
                    data.astroId,
                    redisClient,
                    pubClient
                  );
                }
              }, 8000);
              break;

            case "astrologer_disconnected":
              io.to(data.roomId).emit("user_disconnected", data);
              break;
          }
        } catch (err) {
          logEvent(`RedisError:${ch}`, err.stack, true);
        }
      });
    }

    /* =========================
       SOCKET CONNECTION
    ========================= */

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
  const user = JSON.parse(queueList[i]);
  // stop when current user reached
  if (user.roomId === roomId) break;
  waitTime += user.maximum_time;
}
    if (queueLength >= 1) {
      console.log(`User is in queue. Position: ${queueLength}, Estimated wait time: ${waitTime} minutes`);
        socket.emit("queue_position", {
        message: `You are in queue`,
        position: queueLength-1,
        waitTime:waitTime * 60,
      });
    }
    //  If queue full (LIMIT = 5)
    if (queueLength > 5) {
       socket.emit("queue_full", {
        message: "Astrologer is busy. Please try another astrologer.",
        status: "FULL"
      });
      
      return socket.emit("chat_rejected", {
        message: "Astrologer is busy. Please try another astrologer.",
        status: "FULL"
      });

      
    }
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
         JOIN CHAT
      ========================= */

      onSafe("joinChat", (data) => {
        socket.join(String(data.room_id));
        socket.roomId = String(data.room_id);
      });

      /* =========================
         ✅ SEND MESSAGE (REPLY READY)
      ========================= */

      socket.on("send_message", async (data) => {
        try {
          if (!data.room_id) return;

          const formattedMessage = {
            msg_id:
              data.msg_id || `${Date.now()}_${Math.random()}`,

            sender_id: data.sender_id,
            received_id: data.received_id,
            room_id: data.room_id,

            message: {
              text: sanitizeHtml(
                typeof data.message === "object"
                  ? data.message.text
                  : data.message
              ),
              time:
                data.message?.time ||
                new Date().toISOString(),
            },

            sender: data.sender || "user",
            image: data.image || null,

            replyTo: data.replyTo
              ? {
                  msg_id: data.replyTo.msg_id || null,
                  sender: sanitizeHtml(
                    data.replyTo.sender || ""
                  ),
                  message: sanitizeHtml(
                    data.replyTo.message || ""
                  ).slice(0, 200),
                }
              : null,

            createdAt: new Date().toISOString(),
          };

          // STORE
          await redisClient.rPush(
            `chat_messages:${data.room_id}`,
            JSON.stringify(formattedMessage)
          );

          // PUBLISH
          safePublish(pubClient, "messages", formattedMessage);
        } catch (error) {
          console.error("Send message error:", error);
        }
      });

      /* =========================
         CHAT COMPLETED
      ========================= */

      onSafe("chatCompleted", async (data) => {
        const roomId = data.room_id;

        await finalizeChatSession(
          roomId,
          prisma,
          redisClient,
          data.astroId
        );

        socket.emit("chatCompleted", {
          roomId,
          status: "leave",
        });

        socket.leave(roomId);

        let astroId = data.astroId;

        await pubClient.del(`current_chat:${astroId}`);

        let queueKey = `chat_queue:${astroId}`;
        let queueLength = await pubClient.lLen(queueKey);

        if (queueLength > 0) {
          setTimeout(async () => {
            await processNextChat(
              astroId,
              redisClient,
              pubClient
            );
          }, 3000);
        }
      });

      /* =========================
         TYPING
      ========================= */

      onSafe("typing", (data) => {
        socket.to(data.room_id).emit("typing", {
          typing: data.typing,
          user_name: data.user_name,
        });
      });

      /* =========================
         RECHARGE
      ========================= */
 
      
      onSafe("customer_recharge", (data) => {
        socket.to(data.room_id).emit(
          "open_popup_astrologer"
        );
      });

      onSafe("customer_recharge_completed", (data) => {
        socket.to(data.room_id).emit(
          "customer_recharge_completed",
          data
        );
      });

      onSafe("customer_recharge_fail", (data) => {
        socket.to(data.room_id).emit(
          "customer_recharge_fail"
        );
      });
    });
  } catch (err) {
    logEvent("socketHandlerCritical", err.stack, true);
  }
}

export default socketHandler;