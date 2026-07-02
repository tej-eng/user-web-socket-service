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

  if (!astrologer) throw new Error("Astrologer not found");

  const callPricing = astrologer.pricing.find(
    (p) => p.type === "CALL" && p.isActive,
  );

  if (!callPricing) {
    throw new Error("CALL pricing not configured");
  }

  // -----------------------------------
  // GET USER OFFER USAGE
  // -----------------------------------

  let userOfferUsage = await prisma.userOfferUsage.findUnique({
    where: {
      userId: intake.userId,
    },
  });

  if (!userOfferUsage) {
    userOfferUsage = await prisma.userOfferUsage.create({
      data: {
        userId: intake.userId,
      },
    });
  }

  // -----------------------------------
  // GET GLOBAL PRICING CONFIG
  // -----------------------------------

  const pricingConfig = await prisma.pricingConfig.findFirst();

  // -----------------------------------
  // GET ACTIVE ASTROLOGER OFFER
  // -----------------------------------

  const activeOffer = await prisma.astrologerOffer.findFirst({
    where: {
      astrologerId: intake.astrologerId,
      isActive: true,
    },
    include: {
      offer: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });

  // -----------------------------------
  // PRICE PRIORITY LOGIC
  // -----------------------------------

  let ratePerMin = Math.round(Number(callPricing.price));

  let appliedOffer = "NORMAL";

  /**
   * FIRST TIME OFFER
   */
  if (pricingConfig?.isFirstOfferEnabled && !userOfferUsage.firstOfferUsedAt) {
    ratePerMin = Number(pricingConfig.firstCallPrice);

    appliedOffer = "FIRST_TIME_OFFER";

  } else if (

  /**
   * SECOND TIME OFFER
   */
    pricingConfig?.isSecondOfferEnabled &&
    !userOfferUsage.secondOfferUsedAt
  ) {
    ratePerMin = Number(pricingConfig.secondCallPrice);

    appliedOffer = "SECOND_TIME_OFFER";

  } else if (pricingConfig?.isGlobalOfferEnabled) {

  /**
   * GLOBAL OFFER
   */
    ratePerMin = Number(pricingConfig.globalCallPrice);

    appliedOffer = "GLOBAL_OFFER";

  } else if (

  /**
   * ASTROLOGER SPECIAL OFFER
   * Birthday / Diwali / New Year
   */
    activeOffer?.offer &&
    activeOffer.offer.isActive &&
    Number(activeOffer.offer.price) > 0
  ) {
    ratePerMin = Number(activeOffer.offer.price);

    appliedOffer = "ASTROLOGER_SPECIAL_OFFER";

  } else if (callPricing.offerPrice && Number(callPricing.offerPrice) > 0) {

  /**
   * ASTROLOGER OFFER PRICE
   */
    ratePerMin = Number(callPricing.offerPrice);

    appliedOffer = "ASTROLOGER_OFFER_PRICE";

  }

  console.log("Final Rate Per Min:", ratePerMin);

  console.log("Applied Offer:", appliedOffer);

  // -----------------------------------
  // CREATE SESSION
  // -----------------------------------

  const [session] = await prisma.$transaction([
    prisma.session.create({
      data: {
        userId: intake.userId,
        astrologerId: intake.astrologerId,
        type: "CALL",
        status: "ONGOING",
        ratePerMin,
        source:intake.source,
        roomId:roomId,
        startedAt: new Date(),
      },
    }),

    prisma.astrologer.update({
      where: {
        id: intake.astrologerId,
      },
      data: {
        isBusy: true,
      },
    }),
  ]);

  // -----------------------------------
  // RESERVE OFFER IMMEDIATELY
  // -----------------------------------

  if (appliedOffer === "FIRST_TIME_OFFER") {
    await prisma.userOfferUsage.update({
      where: {
        userId: intake.userId,
      },
      data: {
        firstOfferUsedAt: new Date(),
        usedFirst: true,
      },
    });
  }

  if (appliedOffer === "SECOND_TIME_OFFER") {
    await prisma.userOfferUsage.update({
      where: {
        userId: intake.userId,
      },
      data: {
        secondOfferUsedAt: new Date(),
        usedSecond: true,
      },
    });
  }

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
      appliedOffer,
      ratePerMin,
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

  return session;
};
export const handleCallReject = async (roomId, prisma, redis, pubClient,by) => {
  try {
    const intake = await prisma.intake.findFirst({
      where: { chatId: roomId },
    });

    if (!intake) return null;

    const queueKey = `queue:${intake.astrologerId}`;
    // get full queue
    const queueList = await redis.lRange(queueKey, 0, -1);

    let matchedItem = null;

    //  find correct JSON string
    for (const item of queueList) {
      const parsed = JSON.parse(item);
      if (parsed.roomId === roomId) {
        matchedItem = item;
        break;
      }
    }

    const multi = redis.multi();

    // remove exact match
    if (matchedItem) {
      multi.lRem(queueKey, 0, matchedItem);
    }

    // remove user from set
    const check = await redis.sRem(
      `user_in_queue:${intake.astrologerId}`,
      intake.userId,
    );

    multi.del(`request_data:${roomId}`);

    await multi.exec();
    if (check) {
      await updateQueuePositions(queueKey, redis, pubClient);
    }
    //------for update rejected by status in db-------

  const astrologer = await prisma.astrologer.findUnique({
    where: {
      id: intake.astrologerId,
    },
    include: {
      pricing: {
        where: {
          type: "CALL",
          isActive: true,
        },
      },
    },
  });

  if (!astrologer) {
    throw new Error("Astrologer not found");
  }

  const callPricing = astrologer.pricing.find((p) => p.type === "CALL");

  if (!callPricing) {
    throw new Error("CHAT pricing not configured");
  }

  // -----------------------------------
  // GET USER OFFER USAGE
  // -----------------------------------

  let userOfferUsage = await prisma.userOfferUsage.findUnique({
    where: {
      userId: intake.userId,
    },
  });

  if (!userOfferUsage) {
    userOfferUsage = await prisma.userOfferUsage.create({
      data: {
        userId: intake.userId,
      },
    });
  }

  // -----------------------------------
  // GET GLOBAL PRICING CONFIG
  // -----------------------------------

  const pricingConfig = await prisma.pricingConfig.findFirst();

  // -----------------------------------
  // GET ACTIVE ASTROLOGER OFFER
  // -----------------------------------

  const activeOffer = await prisma.astrologerOffer.findFirst({
    where: {
      astrologerId: intake.astrologerId,
      isActive: true,
    },
    include: {
      offer: true,
    },
    orderBy: {
      updatedAt: "desc",
    },
  });
  // -----------------------------------
  // PRICE PRIORITY LOGIC
  // -----------------------------------

  let ratePerMin = Math.round(callPricing.price);

  let appliedOffer = "NORMAL";

  /**
   * FIRST TIME OFFER
   */
  if (pricingConfig?.isFirstOfferEnabled && !userOfferUsage.firstOfferUsedAt) {
    ratePerMin = Number(pricingConfig.firstChatPrice);

    appliedOffer = "FIRST_TIME_OFFER";

  } else if (

  /**
   * SECOND TIME OFFER
   */
    pricingConfig?.isSecondOfferEnabled &&
    !userOfferUsage.secondOfferUsedAt
  ) {
    ratePerMin = Number(pricingConfig.secondChatPrice);

    appliedOffer = "SECOND_TIME_OFFER";

    console.log("Applying SECOND_TIME_OFFER:", ratePerMin);
  } else if (pricingConfig?.isGlobalOfferEnabled) {

  /**
   * GLOBAL OFFER
   */
    ratePerMin = Number(pricingConfig.globalChatPrice);

    appliedOffer = "GLOBAL_OFFER";

  } else if (

  /**
   * ASTROLOGER SPECIAL OFFER
   * (Birthday / Diwali / New Year etc)
   */
    activeOffer?.offer &&
    activeOffer.offer.isActive &&
    Number(activeOffer.offer.price) > 0
  ) {
    ratePerMin = Number(activeOffer.offer.price);

    appliedOffer = "ASTROLOGER_SPECIAL_OFFER";

  } else if (callPricing.offerPrice && Number(callPricing.offerPrice) > 0) {

  /**
   * ASTROLOGER OFFER PRICE
   */
    ratePerMin = Number(callPricing.offerPrice);

    appliedOffer = "ASTROLOGER_OFFER_PRICE";

  }


  console.log("Applied Offer:", appliedOffer);
     await prisma.session.create({
      data: {
        userId: intake.userId,
        astrologerId: intake.astrologerId,
        type: "CALL",
        status: "CANCELLED",
        ratePerMin,
        source:intake.source,
        roomId:roomId,
        by:by,
        startedAt: new Date(),

      },
    });
    return intake.astrologerId;
  } catch (error) {
    console.error("handleReject error:", error);
    throw error;
  }
};
export const finalizeCallSession = async (roomId, prisma, redis, astroId) => {
  let lockKey = null;
  let lockValue = null;
  try {
    /* =========================
       DELETE REDIS CHAT LIST
    ========================= */
    const currentRoom = await redis.get(`current_call:${astroId}`);
    if (currentRoom) {
      await redis.del(`current_call:${astroId}`);
    }

    /* =========================
   COMPLETE SESSION + WALLET SYNC (ATOMIC)
========================= */
    const active_call = await redis.get(`active_call:${roomId}`);

    if (active_call) {
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

        // ASTROLOGER TRANSACTION (CREDIT) 
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
          await Promise.all([
          tx.session.update({
            where: {
              id: session.id,
            },
            data: {
              status: "COMPLETED",
              endedAt: now,
              durationSec,
              coinsDeducted,
              coinsEarned,
              commission,
            },
          }),

          tx.astrologer.update({
            where: {
              id: session.astrologerId,
            },
            data: {
              isBusy: false,
            },
          }),
        ]);
      });
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

export const removeUserFromQueue = async ({ redis, queueKey, roomId }) => {
  try {
    // =========================
    // GET QUEUE
    // =========================
    const queueList = await redis.lRange(queueKey, 0, -1);

    if (!queueList || queueList.length === 0) {
      return false;
    }

    let itemToRemove = null;

    // =========================
    // FIND ITEM
    // =========================
    for (const item of queueList) {
      try {
        const parsed = JSON.parse(item);

        if (parsed.roomId === roomId) {
          itemToRemove = item;
          break;
        }
      } catch (err) {
        console.error("Queue parse error:", err);
      }
    }

    // =========================
    // REMOVE ITEM
    // =========================
    if (itemToRemove) {
      const removed = await redis.lRem(queueKey, 1, itemToRemove);

      return true;
    }
    console.log(" No matching room found in queue");

    return false;
  } catch (error) {
    console.error("removeUserFromQueue error:", error);

    return false;
  }
};

export const updateQueuePositions = async (queueKey, redis, pubClient) => {
  try {
    const queueList = await redis.lRange(queueKey, 0, -1);

    if (!queueList || queueList.length === 0) return;
    let waitTime = 0;
    for (let i = 0; i < queueList.length; i++) {
      try {
        const parsed = JSON.parse(queueList[i]);

        const payload = {
          roomId: parsed.roomId,
          position: i,
          waitTime: waitTime * 60,
          message: `Your position is ${i}. Estimated wait time ${waitTime} mins`,
          type: parsed.type,
        };

        await pubClient.publish("queue_update", JSON.stringify(payload));
        waitTime += parsed.maximum_time || 0;

        // Add current user's time for next users
      } catch (err) {
        console.error("Queue parse error:", err);
      }
    }
  } catch (error) {
    console.error("updateQueuePositions error:", error);
  }
  return true;
};
