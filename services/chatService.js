export const handleAcceptChat = async (roomId, prisma, redis, pubClient) => {
  const intake = await prisma.intake.findFirst({
    where: { chatId: roomId },
  });

  if (!intake) {
    throw new Error("Chat request not found");
  }

  const astrologer = await prisma.astrologer.findUnique({
    where: {
      id: intake.astrologerId,
    },
    include: {
      pricing: {
        where: {
          type: "CHAT",
          isActive: true,
        },
      },
    },
  });

  if (!astrologer) {
    throw new Error("Astrologer not found");
  }

  const chatPricing = astrologer.pricing.find((p) => p.type === "CHAT");

  if (!chatPricing) {
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

  let ratePerMin = Math.round(chatPricing.price);

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
  } else if (chatPricing.offerPrice && Number(chatPricing.offerPrice) > 0) {
    /**
     * ASTROLOGER OFFER PRICE
     */
    ratePerMin = Number(chatPricing.offerPrice);

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
        type: "CHAT",
        status: "ONGOING",
        ratePerMin,
        source: intake.source,
        roomId: roomId,
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
  // PREVENT MULTIPLE CHATS USING SAME OFFER
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

  // -----------------------------------
  // REDIS
  // -----------------------------------

  const multi = redis.multi();

  multi.sRem(`user_in_queue:${intake.astrologerId}`, intake.userId);

  multi.set(
    `active_chat:${roomId}`,
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

  multi.set(`current_chat:${intake.astrologerId}`, roomId, { EX: 3600 });

  multi.del(`request_data:${roomId}`);

  await multi.exec();

  return session;
};

export const finalizeChatSession = async (roomId, prisma, redis, astroId) => {
  let lockKey = null;
  let lockValue = null;

  try {
    /* =========================
       GET ACTIVE CHAT DATA
    ========================= */
    const activeChatData = await redis.get(`active_chat:${roomId}`);

    let parsedActiveChat = null;
    let activeSessionId = null;

    if (activeChatData) {
      parsedActiveChat = JSON.parse(activeChatData);
      activeSessionId = parsedActiveChat.sessionId;
    }

    /* =========================
       GET ALL MESSAGES FROM REDIS
    ========================= */
    const messages = await redis.lRange(`chat_messages:${roomId}`, 0, -1);

    /* =========================
       ATTACH SESSION ID
    ========================= */
    const parsedMessages = messages.map((m) => {
      const parsed = JSON.parse(m);

      return {
        ...parsed,
        session_id: parsed.session_id || activeSessionId,
      };
    });

    /* =========================
       FRAUD DETECTION LOGIC
    ========================= */
    const fraudFlags = await prisma.fraudFlag.findMany({
      select: {
        keyword: true,
      },
    });

    const fraudKeywords = fraudFlags.map((f) => f.keyword.toLowerCase().trim());

    const fraudLogs = [];

    for (const msg of parsedMessages) {
      if (!msg.message) continue;

      const messageText = msg.message.toLowerCase();

      const matchedKeywords = fraudKeywords.filter((keyword) =>
        messageText.includes(keyword),
      );

      if (matchedKeywords.length > 0) {
        fraudLogs.push({
          orderId: msg.msg_id,

          sessionId: msg.session_id || null,

          senderId: msg.sender_id || null,

          senderName: msg.sender || null,

          receiverId: msg.received_id || null,

          receiverName: msg.sender == "user" ? "Astrologer" : "User",

          message: msg.message,

          matchedKeywords,

          status: "PENDING",
        });
      }
    }

    /* =========================
       SAVE MESSAGES
    ========================= */
    if (parsedMessages.length > 0) {
      await prisma.message.createMany({
        data: parsedMessages.map((msg) => ({
          msgId: msg.msg_id,

          roomId: msg.room_id,

          senderId: msg.sender_id,

          receiverId: msg.received_id,

          message: msg.message,

          image: msg.image,

          sender: msg.sender,

          replyTo: msg.replyTo,

          sessionId: msg.session_id || null,
          time: msg.time,
        })),

        skipDuplicates: true,
      });
    }

    /* =========================
       SAVE FRAUD LOGS
    ========================= */
    if (fraudLogs.length > 0) {
      await prisma.fraudLog.createMany({
        data: fraudLogs,
        skipDuplicates: true,
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

    /* =========================
       COMPLETE SESSION + WALLET
    ========================= */
    if (parsedActiveChat) {
      const parsed = parsedActiveChat;

      lockKey = `finalize_lock:${parsed.sessionId}`;

      lockValue = `${Date.now()}_${Math.random()}`;

      const isLocked = await redis.set(lockKey, lockValue, "NX", "EX", 30);

      if (!isLocked) {
        return;
      }

      const existingTx = await prisma.walletTransaction.findFirst({
        where: {
          sessionId: parsed.sessionId,
        },
      });

      if (existingTx) return;

      await prisma.$transaction(async (tx) => {
        const session = await tx.session.findUnique({
          where: {
            id: parsed.sessionId,
          },
          include: {
            astrologer: {
              include: {
                pricing: {
                  where: {
                    type: "CHAT",
                    isActive: true,
                  },
                },
              },
            },
          },
        });

        if (!session) {
          throw new Error("Session not found");
        }

        if (session.status === "COMPLETED") {
          return;
        }

        /* =========================
             CALCULATE DURATION
          ========================= */

        const now = new Date();
        const startedAt = new Date(session.startedAt);

        const durationSec = Math.floor((now - startedAt) / 1000);
        const ratePerMin = session.ratePerMin || 1;

        let coinsDeducted = 0;

        // First 30 seconds are free
        if (durationSec < 30) {
          coinsDeducted = 0;
        } else {
          // Remove free 30 seconds and round up remaining time
          const billableMinutes = Math.ceil((durationSec - 30) / 60);
          coinsDeducted = billableMinutes * ratePerMin;
        }

        const chatPricing = session.astrologer.pricing[0];

        if (!chatPricing) {
          throw new Error("Chat pricing not configured");
        }

        const commissionPercent = chatPricing.commissionPercent ?? 50;

        const commission = Math.floor(
          (coinsDeducted * commissionPercent) / 100,
        );

        const coinsEarned = coinsDeducted - commission;
        /* =========================
             USER WALLET
          ========================= */
        const userWallet = await tx.userWallet.findUnique({
          where: {
            userId: session.userId,
          },
        });

        await redis.sRem(`user_in_queue:${astroId}`, session.userId);

        if (!userWallet) {
          throw new Error("User wallet not found");
        }

        /* =========================
             ASTRO WALLET
          ========================= */
        const astroWallet = await tx.astrologerWallet.upsert({
          where: {
            astrologerId: session.astrologerId,
          },

          update: {},

          create: {
            astrologerId: session.astrologerId,

            balanceCoins: 0,

            totalEarned: 0,

            totalWithdrawn: 0,
          },
        });

        /* =========================
             BALANCE CHECK
          ========================= */
        if (userWallet.balanceCoins < coinsDeducted) {
          throw new Error("Insufficient balance");
        }

        /* =========================
             USER DEBIT
          ========================= */
        await tx.userWallet.update({
          where: {
            id: userWallet.id,
          },

          data: {
            balanceCoins: {
              decrement: coinsDeducted,
            },
          },
        });

        /* =========================
             ASTRO CREDIT
          ========================= */
        await tx.astrologerWallet.update({
          where: {
            id: astroWallet.id,
          },

          data: {
            balanceCoins: {
              increment: coinsEarned,
            },

            totalEarned: {
              increment: coinsEarned,
            },
          },
        });

        /* =========================
             USER TRANSACTION
          ========================= */
        await tx.walletTransaction.create({
          data: {
            userWalletId: userWallet.id,

            sessionId: session.id,

            type: "DEBIT",

            coins: coinsDeducted,

            description: "Chat session deduction",
          },
        });

        /* =========================
             ASTRO TRANSACTION
          ========================= */
        await tx.walletTransaction.create({
          data: {
            astrologerWalletId: astroWallet.id,

            sessionId: session.id,

            type: "CREDIT",

            coins: coinsEarned,

            description: "Chat session earning",
          },
        });

        /* =========================
             UPDATE SESSION
          ========================= */
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

        //update  PricingConfig usage count
      });

      /* =========================
         DELETE ACTIVE CHAT
      ========================= */
      await redis.del(`active_chat:${roomId}`);
    }

    return true;
  } catch (error) {
    console.error("finalizeChatSession error:", error);

    throw error;
  } finally {
    try {
      if (lockKey && lockValue) {
        const currentValue = await redis.get(lockKey);

        if (currentValue === lockValue) {
          await redis.del(lockKey);
        }
      }
    } catch (err) {
      console.error("Lock cleanup error:", err);
    }
  }
};

export const finalizeChatSessionByAdmin = async (roomId, prisma, redis, astroId) => {
  console.log("finalizeChatSessionByAdmin---------:",roomId, astroId);
  let lockKey = null;
  let lockValue = null;

  try {
    /* =========================
       GET ACTIVE CHAT DATA
    ========================= */
    const activeChatData = await redis.get(`active_chat:${roomId}`);

    let parsedActiveChat = null;
    let activeSessionId = null;

    if (activeChatData) {
      parsedActiveChat = JSON.parse(activeChatData);
      activeSessionId = parsedActiveChat.sessionId;
    }
    console.log("finalizeChatSessionByAdmin----1111111-----:",roomId, astroId);
    /* =========================
       GET ALL MESSAGES FROM REDIS
    ========================= */
    const messages = await redis.lRange(`chat_messages:${roomId}`, 0, -1);

    /* =========================
       ATTACH SESSION ID
    ========================= */
    const parsedMessages = messages.map((m) => {
      const parsed = JSON.parse(m);

      return {
        ...parsed,
        session_id: parsed.session_id || activeSessionId,
      };
    });

    /* =========================
       FRAUD DETECTION LOGIC
    ========================= */
    const fraudFlags = await prisma.fraudFlag.findMany({
      select: {
        keyword: true,
      },
    });
console.log("finalizeChatSessionByAdmin-------2222222--:",roomId, astroId);
    const fraudKeywords = fraudFlags.map((f) => f.keyword.toLowerCase().trim());

    const fraudLogs = [];

    for (const msg of parsedMessages) {
      if (!msg.message) continue;

      const messageText = msg.message.toLowerCase();

      const matchedKeywords = fraudKeywords.filter((keyword) =>
        messageText.includes(keyword),
      );

      if (matchedKeywords.length > 0) {
        fraudLogs.push({
          orderId: msg.msg_id,

          sessionId: msg.session_id || null,

          senderId: msg.sender_id || null,

          senderName: msg.sender || null,

          receiverId: msg.received_id || null,

          receiverName: msg.sender == "user" ? "Astrologer" : "User",

          message: msg.message,

          matchedKeywords,

          status: "PENDING",
        });
      }
    }

    /* =========================
       SAVE MESSAGES
    ========================= */
    console.log("finalizeChatSessionByAdmin-------3333333--:",roomId, astroId);
    if (parsedMessages.length > 0) {
      await prisma.message.createMany({
        data: parsedMessages.map((msg) => ({
          msgId: msg.msg_id,

          roomId: msg.room_id,

          senderId: msg.sender_id,

          receiverId: msg.received_id,

          message: msg.message,

          image: msg.image,

          sender: msg.sender,

          replyTo: msg.replyTo,

          sessionId: msg.session_id || null,
          time: msg.time,
        })),

        skipDuplicates: true,
      });
    }

    /* =========================
       SAVE FRAUD LOGS
    ========================= */
    if (fraudLogs.length > 0) {
      await prisma.fraudLog.createMany({
        data: fraudLogs,
        skipDuplicates: true,
      });
    }
console.log("finalizeChatSessionByAdmin----4444-----:",roomId, astroId);
    /* =========================
       DELETE REDIS CHAT LIST
    ========================= */
    await redis.del(`chat_messages:${roomId}`);

    const currentRoom = await redis.get(`current_chat:${astroId}`);

    if (currentRoom) {
      await redis.del(`current_chat:${astroId}`);
    }

    /* =========================
       COMPLETE SESSION + WALLET
    ========================= */
    if (parsedActiveChat) {
      const parsed = parsedActiveChat;

      lockKey = `finalize_lock:${parsed.sessionId}`;

      lockValue = `${Date.now()}_${Math.random()}`;

      const isLocked = await redis.set(lockKey, lockValue, "NX", "EX", 30);

      if (!isLocked) {
        return;
      }

      const existingTx = await prisma.walletTransaction.findFirst({
        where: {
          sessionId: parsed.sessionId,
        },
      });

      if (existingTx) return;

      await prisma.$transaction(async (tx) => {
        const session = await tx.session.findUnique({
          where: {
            id: parsed.sessionId,
          },
          include: {
            astrologer: {
              include: {
                pricing: {
                  where: {
                    type: "CHAT",
                    isActive: true,
                  },
                },
              },
            },
          },
        });
console.log("finalizeChatSessionByAdmin-----55555555----:",roomId, astroId);
        if (!session) {
          throw new Error("Session not found");
        }

        if (session.status === "COMPLETED") {
          return;
        }

        /* =========================
             CALCULATE DURATION
          ========================= */

        const now = new Date();
        const startedAt = new Date(session.startedAt);

        const durationSec = Math.floor((now - startedAt) / 1000);
        const ratePerMin = session.ratePerMin || 1;

        let coinsDeducted = 0;

        // First 30 seconds are free
        if (durationSec < 30) {
          coinsDeducted = 0;
        } else {
          // Remove free 30 seconds and round up remaining time
          const billableMinutes = Math.ceil((durationSec - 30) / 60);
          coinsDeducted = billableMinutes * ratePerMin;
        }

        const chatPricing = session.astrologer.pricing[0];

        if (!chatPricing) {
          throw new Error("Chat pricing not configured");
        }

        const commissionPercent = chatPricing.commissionPercent ?? 50;

        const commission = Math.floor(
          (coinsDeducted * commissionPercent) / 100,
        );

        const coinsEarned = coinsDeducted - commission;
        /* =========================
             USER WALLET
          ========================= */
        const userWallet = await tx.userWallet.findUnique({
          where: {
            userId: session.userId,
          },
        });

        await redis.sRem(`user_in_queue:${astroId}`, session.userId);
console.log("finalizeChatSessionByAdmin-----6666----:",roomId, astroId);
        if (!userWallet) {
          throw new Error("User wallet not found");
        }

        /* =========================
             ASTRO WALLET
          ========================= */
        // const astroWallet = await tx.astrologerWallet.upsert({
        //   where: {
        //     astrologerId: session.astrologerId,
        //   },

        //   update: {},

        //   create: {
        //     astrologerId: session.astrologerId,

        //     balanceCoins: 0,

        //     totalEarned: 0,

        //     totalWithdrawn: 0,
        //   },
        // });

        /* =========================
             BALANCE CHECK
          ========================= */
        // if (userWallet.balanceCoins < coinsDeducted) {
        //   throw new Error("Insufficient balance");
        // }

        /* =========================
             USER DEBIT
          ========================= */
        // await tx.userWallet.update({
        //   where: {
        //     id: userWallet.id,
        //   },

        //   data: {
        //     balanceCoins: {
        //       decrement: coinsDeducted,
        //     },
        //   },
        // });

        /* =========================
             ASTRO CREDIT
          ========================= */
        // await tx.astrologerWallet.update({
        //   where: {
        //     id: astroWallet.id,
        //   },

        //   data: {
        //     balanceCoins: {
        //       increment: coinsEarned,
        //     },

        //     totalEarned: {
        //       increment: coinsEarned,
        //     },
        //   },
        // });

        /* =========================
             USER TRANSACTION
          ========================= */
        // await tx.walletTransaction.create({
        //   data: {
        //     userWalletId: userWallet.id,

        //     sessionId: session.id,

        //     type: "DEBIT",

        //     coins: coinsDeducted,

        //     description: "Chat session deduction",
        //   },
        // });

        /* =========================
             ASTRO TRANSACTION
          ========================= */
        // await tx.walletTransaction.create({
        //   data: {
        //     astrologerWalletId: astroWallet.id,

        //     sessionId: session.id,

        //     type: "CREDIT",

        //     coins: coinsEarned,

        //     description: "Chat session earning",
        //   },
        // });

        /* =========================
             UPDATE SESSION
          ========================= */
          console.log("finalizeChatSessionByAdmin-----7777777777----:",roomId, astroId);
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
              by:"chat ended by admin"
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

        //update  PricingConfig usage count
      });

      /* =========================
         DELETE ACTIVE CHAT
      ========================= */
      await redis.del(`active_chat:${roomId}`);
    }

    return true;
  } catch (error) {
    console.error("finalizeChatSession error:", error);

    throw error;
  } finally {
    try {
      if (lockKey && lockValue) {
        const currentValue = await redis.get(lockKey);

        if (currentValue === lockValue) {
          await redis.del(lockKey);
        }
      }
    } catch (err) {
      console.error("Lock cleanup error:", err);
    }
  }
};

export const processNextRequest = async (astrologerId, redis, pubClient) => {
  try {
    const queueKey = `queue:${astrologerId}`;
    //const queueItem = await redis.lIndex(queueKey, 0);
    const queueList = await redis.lRange(queueKey, 0, -1);
    const queueItem = queueList[0];
    if (!queueItem) return null;
    const parsedQueue = JSON.parse(queueItem);
    const nextRoomId = parsedQueue.roomId;
    const maximumTime = parsedQueue.maximum_time;
    const userId = parsedQueue.user_id;
    const type = parsedQueue.type;

    if (!nextRoomId) {
      return null;
    }
    // PREVENT DUPLICATE / ALREADY ACTIVE CHAT
    const isActive = await redis.exists(`active_${type}:${nextRoomId}`);
    if (isActive) {
      // Try next user recursively
      return await processNextRequest(astrologerId, redis, pubClient);
    }

    const data = await redis.get(`request_data:${nextRoomId}`);
    if (data) {
      await redis.del(`request_data:${nextRoomId}`);
    } else {
      await redis.lPop(queueKey);
      return;
      //return await processNextChat(astrologerId, redis, pubClient);
    }

    const parsed = JSON.parse(data);
    // Send request to astrologer
    const result = await pubClient.publish(
      `${type}_requests`,
      JSON.stringify({
        room_id: nextRoomId,
        message: `${type} request sent successfully`,
        userName: parsed.userName,
        gender: parsed.gender,
        dateOfBirth: parsed.dateOfBirth,
        timeOfBirth: parsed.timeOfBirth,
        placeOfBirth: "2026-03-19",
        occupation: parsed.occupation,
        location: parsed.location,
        astro_id: parsed.astro_id,
        user_id: parsed.user_id,
        is_promotional: parsed.is_promotional || true,
        maximum_time: parsed.maximum_time || 0,
        user_image: parsed.user_image || "",
        phoneNumber: parsed.phoneNumber || "",
      }),
    );
    if (result) {
    }
    return nextRoomId;
  } catch (error) {
    console.error("processNextRequest error:", error);
    return null;
  }
};
export const handleReject = async (roomId, prisma, redis, pubClient, by) => {
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
            type: "CHAT",
            isActive: true,
          },
        },
      },
    });

    if (!astrologer) {
      throw new Error("Astrologer not found");
    }

    const chatPricing = astrologer.pricing.find((p) => p.type === "CHAT");

    if (!chatPricing) {
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

    let ratePerMin = Math.round(chatPricing.price);

    let appliedOffer = "NORMAL";

    /**
     * FIRST TIME OFFER
     */
    if (
      pricingConfig?.isFirstOfferEnabled &&
      !userOfferUsage.firstOfferUsedAt
    ) {
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
    } else if (chatPricing.offerPrice && Number(chatPricing.offerPrice) > 0) {
      /**
       * ASTROLOGER OFFER PRICE
       */
      ratePerMin = Number(chatPricing.offerPrice);

      appliedOffer = "ASTROLOGER_OFFER_PRICE";
    }

    console.log("Final Rate Per Min:", ratePerMin);

    console.log(
      "chat cancelled:",
      intake.userId,
      intake.astrologerId,
      intake.source,
      roomId,
      by,
    );
    await prisma.session.create({
      data: {
        userId: intake.userId,
        astrologerId: intake.astrologerId,
        type: "CHAT",
        status: "CANCELLED",
        ratePerMin,
        source: intake.source,
        roomId: roomId,
        by: by,
        startedAt: new Date(),
      },
    });
    return intake.astrologerId;
  } catch (error) {
    console.error("handleReject error:", error);
    throw error;
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
