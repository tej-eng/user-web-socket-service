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
  processNextRequest,
  handleReject,
  updateQueuePositions,
} from "../services/chatService.js";
import {
  handleAcceptCall,
  finalizeCallSession,
  processNextCall,
  handleRejectCall,
  removeUserFromQueue,
} from "../services/callService.js";

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
      "callAcceptedByAstrologer",
      "answer",
      "call_ended_by_astrologer",
      "call_cancel_by_astrologer",
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
                await handleReject(data.roomid, prisma, redisClient, pubClient);
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
              console.log(
                "Queue update received in socket handler:queue_positionuuuuuuuuuuuuuuuuuuuuuuuuu",
                data,
              );
              io.to(data.roomId).emit("queue_position", data);
              console.log(
                "Queue update emitted to clients:queue_positionuuuuuuuuuuuuuuuuuuuuuuuuuAFTER",
                data.roomId,
              );
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
              let queueKey = `queue:${data.astroId}`;
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
                console.log(
                  "Item to remove from queueccccccccc:",
                  itemToRemove,
                );
                const check = await redisClient.lRem(queueKey, 1, itemToRemove);
                if (check) {
                  console.log(
                    "Item removed from queue successfully after astrologer ended chat",
                  );
                  const res = await updateQueuePositions(
                    queueKey,
                    redisClient,
                    pubClient,
                  );
                  if (res) {
                    setTimeout(async () => {
                      try {
                        const queueLength = await pubClient.lLen(queueKey);
                        if (queueLength > 0) {
                          await processNextRequest(
                            data.astroId,
                            redisClient,
                            pubClient,
                          );
                        }
                      } catch (err) {
                        console.error(
                          "Delayed processNextRequest errorAAAAAAAAA:",
                          err,
                        );
                      }
                    }, 8000);
                  }
                }
              }
              //-------END CODE FOR DELETE KEY AFTER ASTRLOGER CHAT END-------

              break;

            case "astrologer_disconnected":
              io.to(data.roomId).emit("user_disconnected", data);
              const res = await handleReject(
                data.roomId,
                prisma,
                redisClient,
                pubClient,
              );
              if (res) {
                console.log(
                  "Queue positions updated successfully after user ended chatEEEEEEEEEEEEEEE",
                );
                let queueLength = await pubClient.lLen(`queue:${data.astroid}`);
                if (queueLength > 0) {
                  setTimeout(async () => {
                    await processNextRequest(
                      data.astroid,
                      redisClient,
                      pubClient,
                    );
                  }, 5000);
                }
              }
              //handelRejectChat(data.roomId, prisma, redisClient, pubClient);
              break;

            case "callAcceptedByAstrologer":
              console.log("Received callAcceptedByAtrologer message:", data);
              /* let parsed = data;
              console.log("Received callAcceptedByAtrologer data:", parsed);
              try {
                parsed = JSON.parse(parsed);

                //  handle double stringify
                if (typeof parsed === "string") {
                  console.log("Data was double stringified, parsing again:", parsed);
                  parsed = JSON.parse(parsed);
                }

              } catch (e) {
                console.error(" JSON PARSE ERROR:", e);
                return;
              }

              console.log("FINAL DATA:", parsed);
              console.log("ROOM:", parsed.roomId);

              if (!parsed.roomId) {
                console.error(" STILL NO ROOM ID", parsed);
                return;
              }*/
              console.log(
                "Handling call acceptance for roomId:444444444444",
                data.roomId,
              );
              handleAcceptCall(data.roomId, prisma, redisClient, pubClient);
              io.to(data.roomId).emit("callAcceptedByAstrologer", data);
              break;
            case "answer":
              console.log("Received answer message:", data);
              io.to(data.room_id).emit("answer", data);
              console.log("Emitted answer to room:", data.room_id);
              break;
            case "call_ended_by_astrologer":
              console.log("Received call_ended_by_astrologer message:", data);
              io.to(data.roomId).emit("call_ended_by_astrologer", data);
              finalizeCallSession(
                data.roomId,
                prisma,
                redisClient,
                data.astroId,
              );
              removeUserFromQueue({
                redis: redisClient,
                queueKey: `queue:${data.astroId}`,
                roomId: data.roomId,
              });
              const response = await updateQueuePositions(
                `queue:${data.astroId}`,
                redisClient,
                pubClient,
              );
              if (response) {
                console.log(
                  "Queue positions updated successfully for call after user ended callEEEEEEEEEEEEEEE",
                );
                let queueLength = await pubClient.lLen(
                  `queue:${data.astroId}`,
                );
                if (queueLength > 0) {
                  setTimeout(async () => {
                    await processNextRequest(
                      data.astroId,
                      redisClient,
                      pubClient,
                    );
                  }, 5000);
                }
              }
              break;
            case "call_cancel_by_astrologer":
              console.log("Received call_cancel_by_astrologer message:", data);
              await handleReject(data.roomId, prisma, redisClient, pubClient);
              io.to(data.roomId).emit("call_cancel_by_astrologer", data);
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
          console.log("commit AAAAAAAAAAAAAA chat_request");
          const astroId = data.astro_id;
          const queueKey = `queue:${astroId}`;
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

          if (queueLength === 1) {
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

            socket.emit("queue_position", {
              message: `You are in queue`,
              position: queueLength - 1,
              waitTime: waitTime * 60,
              type: "chat",
            });
          }
        } catch (err) {
          console.error("chat_request error:", err);
        }
      });

      onSafe("call_request", async (data) => {
        try {
          console.log("Received call_request data:", data);
          const astroId = data.astro_id;
          const queueKey = `queue:${astroId}`;
          const roomId = data.room_id;
          socket.join(String(roomId));
          socket.roomId = String(roomId);

          // Get current queue length
          const queueLength = await pubClient.lLen(queueKey);
          if (queueLength == 0) return;

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

          if (queueLength === 1) {
            pubClient.publish(
              "call_start",
              JSON.stringify({
                room_id: roomId,
                callerId: data.user_id,
                receiverId: astroId,
                callTime: data.maximum_time,
              }),
            );
          } else {
            socket.emit("queue_position", {
              message: `You are in queue`,
              position: queueLength - 1,
              waitTime: waitTime * 60,
              type: "call",
            });
          }
        } catch (err) {
          console.error("call_request error:", err);
        }
      });

      onSafe("join_call", async ({ roomId }) => {
        console.log("Joining call room:", roomId);
        console.log("Socket ID:", socket.id);

        await socket.join(roomId);

        console.log("Joined call room:", roomId);

        const clients = await io.in(roomId).fetchSockets();

        console.log(
          "Clients in room:",
          clients.map((s) => s.id),
        );

        // emit only if 2 users present
        if (clients.length > 1) {
          console.log("Sending peer_joined");

          socket.to(roomId).emit("peer_joined");

          // optional:
          socket.emit("peer_joined");
        }
      });

      onSafe("offer", ({ room_id, offer }) => {
        console.log("Received offer for room:", room_id);
        safePublish(pubClient, "offer", {
          room_id: room_id,
          offer: offer,
        });
      });

      onSafe("ice-candidate", ({ room_id, candidate }) => {
        console.log("Received ice candidate for room:", room_id);
        // socket.to(room_id).emit("ice_candidate", { candidate });
        safePublish(pubClient, "ice_candidate", {
          room_id: room_id,
          candidate: candidate,
        });
      });

      onSafe("call_ended_by_user", async (data) => {
        safePublish(pubClient, "call_ended_by_user", {
          room_id: data.room_id,
        });
        console.log(
          "Emitted call_ended_by_user for roomAAAAAAAAAa:",
          data.room_id,
          data.astro_id,
        );
        finalizeCallSession(data.room_id, prisma, redisClient, data.astro_id);
        removeUserFromQueue({
          redis: redisClient,
          queueKey: `queue:${data.astro_id}`,
          roomId: data.room_id,
        });
        const response = await updateQueuePositions(
          `queue:${data.astro_id}`,
          redisClient,
          pubClient,
        );
        if (response) {
          console.log(
            "Queue positions updated successfully for call after user ended callEEEEEEEEEEEEEEE",
          );
          let queueLength = await pubClient.lLen(`queue:${data.astro_id}`);
          if (queueLength > 0) {
            setTimeout(async () => {
              await processNextRequest(data.astro_id, redisClient, pubClient);
            }, 5000);
          }
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
      onSafe("rejoin_queue", async (data) => {
        const roomId = String(data.room_id);

        socket.join(roomId);
        socket.roomId = roomId;

        console.log("User rejoined room after refresh:", roomId);

        // OPTIONAL: send latest queue position immediately
        try {
          // const queueKey = `chat_queue:${data.astro_id}`;
          // const queueList = await redisClient.lRange(queueKey, 0, -1);
          // let position = -1;
          // let waitTime = 0;
          // for (let i = 0; i < queueList.length; i++) {
          //   const user = JSON.parse(queueList[i]);
          //   if (user.roomId === roomId) {
          //     position = i;
          //     break;
          //   }
          //   waitTime += user.maximum_time;
          // }
          // socket.emit("queue_position", {
          //   roomId,
          //   position,
          //   waitTime: waitTime * 60,
          //   message: "Restored queue position after refresh"
          // });
        } catch (err) {
          console.error("Rejoin queue error:", err);
        }
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
          let queueKey = `queue:${data.astroId}`;
          console.log(
            "Queue key to remove item from after user ended chat:AAAAAAAAAAAAAAA",
            queueKey,
          );
          const queueList = await pubClient.lRange(queueKey, 0, -1);
          let itemToRemove = null;

          for (const item of queueList) {
            const parsed = JSON.parse(item);
            console.log(
              "Checking queue item for removal after user ended chat:BBBBBBBBBBB",
              parsed,
              parsed.roomId,
              " === ",
              data.room_id,
            );
            if (parsed.roomId === data.room_id) {
              itemToRemove = item;
              break;
            }
          }

          if (itemToRemove) {
            console.log(
              "Item to remove from queue after user ended chat:CCCCCCCCCCCCCC:",
              itemToRemove,
            );
            const check = await pubClient.lRem(queueKey, 1, itemToRemove);
          }

          console.log(
            "Item removed from queue successfully after user ended chatDDDDDDDDDDD",
          );
          const res = await updateQueuePositions(
            queueKey,
            redisClient,
            pubClient,
          );
          if (res) {
            console.log(
              "Queue positions updated successfully after user ended chatEEEEEEEEEEEEEEE",
            );
            let queueLength = await pubClient.lLen(queueKey);
            if (queueLength > 0) {
              setTimeout(async () => {
                await processNextRequest(astroId, redisClient, pubClient);
              }, 5000);
            }
          }

          //-------END CODE FOR DELETE KEY AFTER USER CHAT END-------
        } catch (error) {
          console.error("chat complete error", error);
        }
      });

      onSafe("cancel_chat_request", async (data) => {
        console.log("Received cancel_chat_requestTTTTTTTTTTTTTT:", data);
        const res = await handleReject(
          data.room_id,
          prisma,
          redisClient,
          pubClient,
        );
        if (res) {
          console.log(
            "Queue positions updated successfully after user ended chatEEEEEEEEEEEEEEE",
          );
          let queueLength = await pubClient.lLen(`queue:${data.astroid}`);
          if (queueLength > 0) {
            setTimeout(async () => {
              await processNextRequest(data.astroid, redisClient, pubClient);
            }, 5000);
          }
        }
        io.emit("chat_rejected", data);

        safePublish(pubClient, "chat_cancel_by_user", {
          roomId: data.room_id,
          astroid: data.astroid,
          user_id: data.user_id,
          message: "User has cancelled the chat request",
        });
      });

      onSafe("cancel_call_request", async (data) => {
        const res = await handleReject(
          data.room_id,
          prisma,
          redisClient,
          pubClient,
        );
        if (res) {
          console.log(
            "Queue positions updated successfully after user ended callEEEEEEEEEEEEEEE",
          );
          let queueLength = await pubClient.lLen(`queue:${data.astroid}`);
          if (queueLength > 0) {
            setTimeout(async () => {
              await processNextRequest(data.astroid, redisClient, pubClient);
            }, 5000);
          }
        }

        safePublish(pubClient, "call_cancel_by_user", {
          roomId: data.room_id,
          astroid: data.astroid,
          user_id: data.user_id,
          message: "User has cancelled the call request",
        });
      });

      // onSafe("queue_cancel", async (data) => {
      //   io.emit("chat_rejected", data);
      //   safePublish(pubClient, "chat_cancel_by_user", {
      //     roomId: data.room_id,
      //     astroid: data.astroid,
      //     user_id: data.user_id,
      //     message: "User has cancelled the chat request from queue",
      //   });
      //   const res = await handleReject(
      //     data.room_id,
      //     prisma,
      //     redisClient,
      //     pubClient,
      //   );
      //   if (res) {
      //     console.log(
      //       "Queue positions updated successfully after user ended chatEEEEEEEEEEEEEEE",
      //     );
      //     let queueLength = await pubClient.lLen(`queue:${data.astroid}`);
      //     if (queueLength > 0) {
      //       setTimeout(async () => {
      //         await processNextRequest(data.astroid, redisClient, pubClient);
      //       }, 5000);
      //     }
      //   }
      // });

      onSafe("autodisconnect", async (data) => {
        console.log("Received autodisconnect event FROM USER SIDE :", data);
        const roomId = String(data.room_id);
        const astroId = String(data.astroid);
        try {
          if (roomId) {
            socket.broadcast.emit(`${data.type}_reject_auto`, {
              message: `${roomId} has been automatically rejected after 1 minute.`,
              roomId: roomId,
              status: "reject",
            });
            socket.leave(roomId);
            safePublish(pubClient, `${data.type}_reject_auto`, {
              message: `${roomId} has been automatically rejected after 1 minute.`,
              roomId: roomId,
              status: "reject",
            });

            const res = await handleReject(
              roomId,
              prisma,
              redisClient,
              pubClient,
            );
            if (res) {
              console.log(
                "Queue positions updated successfully after user ended chatEEEEEEEEEEEEEEE",
              );
              let queueLength = await pubClient.lLen(`queue:${data.astroid}`);
              if (queueLength > 0) {
                setTimeout(async () => {
                  await processNextRequest(
                    data.astroid,
                    redisClient,
                    pubClient,
                  );
                }, 5000);
              }
            }
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
        socket.to(data.room_id).emit("customer_recharge_completed", {
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
