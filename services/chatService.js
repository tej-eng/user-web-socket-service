export const handleAcceptChat = async (roomId, prisma, redis) => {
  console.log("Handling chat acceptance for room:", roomId);

  const intake = await prisma.intake.findFirst({
    where: { chatId: roomId }
  });

  if (!intake) throw new Error("Chat request not found");

  const astrologer = await prisma.astrologer.findUnique({
    where: { id: intake.astrologerId }
  });

  if (!astrologer) throw new Error("Astrologer not found");

  const session = await prisma.session.create({
    data: {
      userId: intake.userId,
      astrologerId: intake.astrologerId,
      type: "CHAT",
      status: "ONGOING",
      ratePerMin: Math.round(astrologer.price),
      startedAt: new Date()
    }
  });

  console.log("Session created:", session.id);

  //  CORRECT REDIS MULTI (v4)
  const multi = redis.multi();
 multi.lRem(`chat_queue:156983`, 1, roomId);  //used for testing
  //multi.lRem(`chat_queue:${intake.astrologerId}`, 1, roomId); //used for production

  multi.set(
    `active_chat:${roomId}`,
    JSON.stringify({
      sessionId: session.id,
      userId: intake.userId,
      astrologerId: intake.astrologerId,
      startTime: Date.now()
    }),
    { EX: 3600 }
  );

  multi.del(`chat_request_data:${roomId}`);

  await multi.exec();

  console.log("Chat moved to active:", roomId);

  return session;
};
export const finalizeChatSession = async (roomId, prisma, redis) => {
  try {
    console.log("Finalizing chat for room:", roomId);

    /* =========================
        GET ALL MESSAGES FROM REDIS
    ========================= */
    const messages = await redis.lRange(
      `chat_messages:${roomId}`,
      0,
      -1
    );

    const parsedMessages = messages.map(m => JSON.parse(m));

    console.log("Messages to store:", parsedMessages.length);

    /* =========================
       SAVE TO DB (BULK)
    ========================= */
    if (parsedMessages.length > 0) {
      await prisma.message.createMany({
        data: parsedMessages.map(msg => ({
          msgId: msg.msg_id,
          roomId: msg.room_id,
          senderId: msg.sender_id,
          receiverId: msg.received_id,
          message: msg.message,
          image: msg.image,
          sender: msg.sender,
          replyTo: msg.replyTo,
        })),
        skipDuplicates: true 
      });
    }

    /* =========================
       DELETE REDIS CHAT LIST
    ========================= */
    await redis.del(`chat_messages:${roomId}`);

    /* =========================
       COMPLETE SESSION
    ========================= */
    const activeChat = await redis.get(`active_chat:${roomId}`);

    if (activeChat) {
      const parsed = JSON.parse(activeChat);

      await prisma.session.update({
        where: { id: parsed.sessionId },
        data: {
          status: "COMPLETED",
          endedAt: new Date()
        }
      });

      await redis.del(`active_chat:${roomId}`);
    }

    console.log("Chat finalized successfully:", roomId);

    return true;

  } catch (error) {
    console.error("finalizeChatSession error:", error);
    throw error;
  }
};

// services/chatService.js
export const processNextChat = async (
  astrologerId,
  redis,
  pubClient
) => {
  try {
    const queueKey = `chat_queue:${astrologerId}`;

    //  Get next roomId
    const nextRoomId = await redis.lIndex(queueKey, 0);

    if (!nextRoomId) {
      console.log("No users in queue for astrologer:", astrologerId);
      return null;
    }

    console.log("Next roomId from queue:", nextRoomId);

    // PREVENT DUPLICATE / ALREADY ACTIVE CHAT
    const isActive = await redis.exists(`active_chat:${nextRoomId}`);
    if (isActive) {
      console.log("Room already active, skipping:", nextRoomId);

      // OPTIONAL: remove it from queue (cleanup)
      await redis.lRem(queueKey, 1, nextRoomId);

      // Try next user recursively
      return await processNextChat(astrologerId, redis, pubClient);
    }
 
    const data = await redis.get(`chat_request_data:${nextRoomId}`);
    if (data) {
      await redis.del(`chat_request_data:${nextRoomId}`);
    }

    const parsed = JSON.parse(data);
    console.log("Parsed chat request data:", parsed);
    // Send request to astrologer
   const result = await pubClient.publish(
      "chat_requests",
      JSON.stringify({
        room_id: nextRoomId,
        message: "Chat request sent successfully", 
        userName: parsed.userName,
        gender: parsed.gender,
        dateOfBirth: parsed.dateOfBirth,
        timeOfBirth: parsed.timeOfBirth,
        placeOfBirth: "2026-03-19" ,
        occupation: parsed.occupation,
        location: parsed.location,
        astro_id:156983,
        user_id: parsed.user_id,
        is_promotional: parsed.is_promotional || true,
        maximum_time: parsed.maximum_time || 0,
        user_image: parsed.user_image || "",
        phoneNumber: parsed.phoneNumber || "",
      })
    );
    if(result){
      console.log("Chat request published to astrologer:", nextRoomId);
    }

    // Update queue positions (optional but useful)
    const queue = await redis.lRange(queueKey, 0, -1);

    queue.forEach((roomId, index) => {
      pubClient.publish(
        "queue_update",
        JSON.stringify({
          roomId,
          position: index + 1
        })
      );
    });

    return nextRoomId;

  } catch (error) {
    console.error("processNextChat error:", error);
    return null;
  }
};
export const handleRejectChat = async (roomId, prisma, redis) => {
  try {
    console.log("Handling chat rejection for room:", roomId);

    const intake = await prisma.intake.findFirst({
      where: { chatId: roomId }
    });

    const multi = redis.multi();

    if (intake) {
      //multi.lRem(`chat_queue:${intake.astrologerId}`, 0, roomId); //for production
      multi.lRem(`chat_queue:156983`, 0, roomId);     //for testing
    }

    multi.del(`chat_request_data:${roomId}`);
    //multi.del(`active_chat:${roomId}`);

    await multi.exec();

    console.log("Rejected chat cleaned:", roomId);

    return intake ? intake.astrologerId : null;

  } catch (error) {
    console.error("handleRejectChat error:", error);
    throw error;
  }
};
