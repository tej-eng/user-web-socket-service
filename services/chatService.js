export const handleAcceptChat = async (roomId, prisma, redis) => {

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


  //  CORRECT REDIS MULTI (v4)
  const multi = redis.multi();
  multi.lRem(`chat_queue:${intake.astrologerId}`, 1, roomId); //used for production

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
  multi.set(
  `current_chat:${intake.astrologerId}`,//for testing
  roomId,
  { EX: 3600 }
);

  multi.del(`chat_request_data:${roomId}`);

  await multi.exec();


  return session;
};
export const finalizeChatSession = async (roomId, prisma, redis,astroId) => {
  let lockKey = null;
  let lockValue = null;
  try {
    /* =========================
        GET ALL MESSAGES FROM REDIS
    ========================= */
    const messages = await redis.lRange(
      `chat_messages:${roomId}`,
      0,
      -1
    );

    const parsedMessages = messages.map(m => JSON.parse(m));

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

    const currentRoom = await redis.get(`current_chat:${astroId}`);
          if (currentRoom) {
          await redis.del(`current_chat:${astroId}`);
          }
//------------------------REMOVE FROM QUEUE IF STILL PRESENT (EDGE CASE)----------------------
const queueKey = `chat_queue:${astroId}`;
const queueList = await redis.lRange(queueKey, 0, -1);

let itemToRemove = null;

for (const item of queueList) {
  const parsed = JSON.parse(item);

  if (parsed.roomId === roomId) {
    itemToRemove = item;
    break;
  }
}

if (itemToRemove) {
  await redis.lRem(queueKey, 1, itemToRemove);
}

    /* =========================
   COMPLETE SESSION + WALLET SYNC (ATOMIC)
========================= */
const activeChat = await redis.get(`active_chat:${roomId}`);

if (activeChat) {
  const parsed = JSON.parse(activeChat);

  lockKey = `finalize_lock:${parsed.sessionId}`;
  lockValue = `${Date.now()}_${Math.random()}`;

const isLocked = await redis.set(lockKey, lockValue, "NX", "EX", 30);

  if (!isLocked) {
    return;
  }

  const existingTx = await prisma.walletTransaction.findFirst({
  where: { sessionId: parsed.sessionId },
});

if (existingTx) return;

  await prisma.$transaction(async (tx) => {
    const session = await tx.session.findUnique({
      where: { id: parsed.sessionId },
    });

    if (!session) throw new Error("Session not found");

    // Prevent duplicate execution
    if (session.status === "COMPLETED") return;

    // Duration
    const now = new Date();
    const startedAt = new Date(session.startedAt);
    const durationSec = Math.floor((now - startedAt) / 1000);

    const ratePerMin = session.ratePerMin || 1;

    let coinsDeducted = 0;

    if (durationSec <= 30) {
      coinsDeducted = ratePerMin; // minimum 1 min
    } else {
      const durationMin = durationSec / 60;
      coinsDeducted = Math.ceil(durationMin * ratePerMin);
    }

    // Commission 50%
    const commission = Math.floor(coinsDeducted * 0.5);
    const coinsEarned = coinsDeducted - commission;

    // USER WALLET (must exist)
const userWallet = await tx.userWallet.findUnique({
  where: { userId: session.userId },
});

if (!userWallet) {
  throw new Error("User wallet not found");
}

// ASTRO WALLET (AUTO CREATE if not exists)
const astroWallet = await tx.astrologerWallet.upsert({
  where: { astrologerId: session.astrologerId },
  update: {}, // nothing to update
  create: {
    astrologerId: session.astrologerId,
    balanceCoins: 0,
    totalEarned: 0,
    totalWithdrawn: 0,
  },
});

    // Optional: balance check
    if (userWallet.balanceCoins < coinsDeducted) {
      throw new Error("Insufficient balance");
    }

    // USER DEBIT
    await tx.userWallet.update({
      where: { id: userWallet.id },
      data: {
        balanceCoins: {
          decrement: coinsDeducted,
        },
      },
    });

    // ASTROLOGER CREDIT
    await tx.astrologerWallet.update({
      where: { id: astroWallet.id },
      data: {
        balanceCoins: {
          increment: coinsEarned,
        },
        totalEarned: {
          increment: coinsEarned,
        },
      },
    });

    // USER TRANSACTION (DEBIT)
    await tx.walletTransaction.create({
      data: {
        userWalletId: userWallet.id,
        sessionId: session.id,
        type: "DEBIT",
        coins: coinsDeducted,
        description: "Chat session deduction",
      },
    });

    // ASTROLOGER TRANSACTION (CREDIT) ✅ YOUR REQUIRED PART
    await tx.walletTransaction.create({
      data: {
        astrologerWalletId: astroWallet.id,
        sessionId: session.id,
        type: "CREDIT",
        coins: coinsEarned,
        description: "Chat session earning",
      },
    });

    // FINAL: update session
    await tx.session.update({
      where: { id: session.id },
      data: {
        status: "COMPLETED",
        endedAt: now,
        durationSec,
        coinsDeducted,
        coinsEarned,
        commission,
      },
    });
  });

  await redis.del(`active_chat:${roomId}`);
}


    return true;

  } catch (error) {
    console.error("finalizeChatSession error:", error);
    throw error;
  }
  finally {
  try {
    if (lockKey && lockValue) {
      const currentValue = await redis.get(lockKey);

      // Only delete if THIS process owns the lock
      if (currentValue === lockValue) {
        await redis.del(lockKey);
      }
    }
  } catch (err) {
    console.error("Lock cleanup error:", err);
  }
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
      const queueItem = await redis.lIndex(queueKey, 0);
      console.log("Next queue item for astrologer", astrologerId, queueItem);
      if (!queueItem) return null;
      const parsedQueue = JSON.parse(queueItem);
      const nextRoomId = parsedQueue.roomId;
      const maximumTime = parsedQueue.maximum_time;
      const userId = parsedQueue.user_id;
     console.log("Parsed queue item:", nextRoomId);
    if (!nextRoomId) {
      return null;
    }
    // PREVENT DUPLICATE / ALREADY ACTIVE CHAT
    const isActive = await redis.exists(`active_chat:${nextRoomId}`);
    if (isActive) {
            // OPTIONAL: remove it from queue (cleanup)
            const queueList = await redis.lRange(queueKey, 0, -1);

            let itemToRemove = null;

            for (const item of queueList) {
            const parsed = JSON.parse(item);

            if (parsed.roomId === roomId) {
            itemToRemove = item;
            break;
            }
            }

            if (itemToRemove) {
            await redis.lRem(queueKey, 1, itemToRemove);
            }

      // Try next user recursively
      return await processNextChat(astrologerId, redis, pubClient);
    }
 
   const data = await redis.get(`chat_request_data:${nextRoomId}`);
   console.log("Chat request data for room:", nextRoomId, data);
   if (data) {
    
   await redis.del(`chat_request_data:${nextRoomId}`);
  }else{
    console.warn(`No chat request data found for room ${nextRoomId}`);
    //return await processNextChat(astrologerId, redis, pubClient);
  }

const parsed = JSON.parse(data);
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
        astro_id:parsed.astro_id,
        user_id: parsed.user_id,
        is_promotional: parsed.is_promotional || true,
        maximum_time: parsed.maximum_time || 0,
        user_image: parsed.user_image || "",
        phoneNumber: parsed.phoneNumber || "",
      })
    );
    if(result){
    }

    // Update queue positions (optional but useful)
    const queue = await redis.lRange(queueKey, 0, -1);

    queue.forEach((userData, index) => {
      console.log(`Updating position for room ----------------------------${userData.roomId} to ${index + 1}`);
      pubClient.publish(
        "queue_update",
        JSON.stringify({
          roomId: userData.roomId,
          position: index + 1,
          waitTime:120,
          message:`Now Your position is changed in queue ${index + 1}`
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
    const intake = await prisma.intake.findFirst({
      where: { chatId: roomId }
    });

    const multi = redis.multi();

    if (intake) {
      multi.lRem(`chat_queue:${intake.astrologerId}`, 0, roomId); //for production
    }

    multi.del(`chat_request_data:${roomId}`);
    //multi.del(`active_chat:${roomId}`);
    await multi.exec();
    return intake ? intake.astrologerId : null;

  } catch (error) {
    console.error("handleRejectChat error:", error);
    throw error;
  }
};
