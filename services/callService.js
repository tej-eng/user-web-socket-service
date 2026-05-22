export const handleAcceptCall = async (roomId, prisma, redis, pubClient) => {
  console.log("Handling call acceptance for roomId:111111111111", roomId);
  const intake = await prisma.intake.findFirst({
    where: { chatId: roomId },
  });

  if (!intake) throw new Error("Call request not found");

 const astrologer = await prisma.astrologer.findUnique({
  where: { id: intake.astrologerId },
  include: {
    pricing: true,
  },
});
  console.log("Astrologer details for accepted call:", astrologer);

  if (!astrologer) throw new Error("Astrologer not found");

  const callPricing = astrologer.pricing.find(
  (p) => p.type === "CALL" && p.isActive
);

if (!callPricing) {
  throw new Error("CALL pricing not configured");
}

  const session = await prisma.session.create({
  data: {
    userId: intake.userId,
    astrologerId: intake.astrologerId,
    type: "CALL",
    status: "ONGOING",
    ratePerMin: Math.round(callPricing.offerPrice || callPricing.price),
    startedAt: new Date(),
  },
});
  console.log("Created session for roomId:333333333333", roomId, "Session:", session);

  const queueKey = `queue:${intake.astrologerId}`;
  //await updateQueuePositions(queueKey, redis, pubClient);

  //  CORRECT REDIS MULTI (v4)
  const multi = redis.multi();
  multi.sRem(`user_in_queue:${intake.astrologerId}`, intake.userId);
  multi.set(
    `active_call:${roomId}`,
    JSON.stringify({
      sessionId: session.id,
      userId: intake.userId,
      astrologerId: intake.astrologerId,
      startTime: Date.now(),
    }),
    { EX: 3600 },
  );
  multi.set(
    `current_call:${intake.astrologerId}`, //for testing
    roomId,
    { EX: 3600 },
  );

  multi.del(`request_data:${roomId}`);

  const check = await multi.exec();
  console.log("Redis multi exec result for accepting call for roomId:444444444444", roomId, "Result:", check);

  return session;
};
export const finalizeCallSession = async (roomId, prisma, redis, astroId) => {
  console.log("Finalizing call session for roomId:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", roomId, "astroId:", astroId);
  let lockKey = null;
  let lockValue = null;
  try {
    /* =========================
       DELETE REDIS CHAT LIST
    ========================= */
    const currentRoom = await redis.get(`current_call:${astroId}`);
    console.log("Current room for astroId11111111111", astroId, "is", currentRoom);
    if (currentRoom) {
      await redis.del(`current_call:${astroId}`);
    }
   

    /* =========================
   COMPLETE SESSION + WALLET SYNC (ATOMIC)
========================= */
    const active_call = await redis.get(`active_call:${roomId}`);

    if (active_call) {
      console.log("Active call data found for roomId:222222222222", roomId, "Data:", active_call);
      const parsed = JSON.parse(active_call);

      lockKey = `finalize_lock:${parsed.sessionId}`;
      lockValue = `${Date.now()}_${Math.random()}`;

      const isLocked = await redis.set(lockKey, lockValue, "NX", "EX", 30);

      if (!isLocked) {
        return;
      }

      const existingTx = await prisma.walletTransaction.findFirst({
        where: { sessionId: parsed.sessionId },
      });
     console.log("Existing transaction check for sessionId:333333333333", parsed.sessionId, "Result:", existingTx);
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
        await redis.sRem(`user_in_queue:${astroId}`, session.userId);
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
            description: "Call session deduction",
          },
        });

        // ASTROLOGER TRANSACTION (CREDIT) ✅ YOUR REQUIRED PART
        await tx.walletTransaction.create({
          data: {
            astrologerWalletId: astroWallet.id,
            sessionId: session.id,
            type: "CREDIT",
            coins: coinsEarned,
            description: "Call session earning",
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
      console.log("Session finalized and wallets updated for roomId:8888888888888888", `active_call:${roomId}`);
      await redis.del(`active_call:${roomId}`);
    }

    return true;
  } catch (error) {
    console.error("finalizeCallSession error:", error);
    throw error;
  } finally {
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



export const removeUserFromQueue = async ({
  redis,
  queueKey,
  roomId,
}) => {
  try {
    console.log(
      "🔍 Removing queue item:",
      roomId,
      "from",
      queueKey
    );

    // =========================
    // GET QUEUE
    // =========================
    const queueList =
      await redis.lRange(
        queueKey,
        0,
        -1
      );

    if (
      !queueList ||
      queueList.length === 0
    ) {
      console.log(
        "⚠️ Queue empty"
      );

      return false;
    }

    let itemToRemove = null;

    // =========================
    // FIND ITEM
    // =========================
    for (const item of queueList) {
      try {
        const parsed =
          JSON.parse(item);

        console.log(
          "Checking queue item:",
          parsed.roomId,
          "===",
          roomId
        );

        if (
          parsed.roomId === roomId
        ) {
          itemToRemove = item;
          break;
        }
      } catch (err) {
        console.error(
          "Queue parse error:",
          err
        );
      }
    }

    // =========================
    // REMOVE ITEM
    // =========================
    if (itemToRemove) {
      const removed =
        await redis.lRem(
          queueKey,
          1,
          itemToRemove
        );

      console.log(
        "✅ Removed from queue:",
        removed
      );

      return true;
    }

    console.log(
      "⚠️ No matching room found in queue"
    );

    return false;
  } catch (error) {
    console.error(
      "removeUserFromQueue error:",
      error
    );

    return false;
  }
};
