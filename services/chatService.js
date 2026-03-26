
export const handleAcceptChat = async (roomId, prisma, redis) => {
  console.log("Handling chat acceptance for room:", roomId);

  // Get intake from DB
  const intake = await prisma.intake.findFirst({
    where: { chatId: roomId }
  });

  if (!intake) throw new Error("Chat request not found");

  //  Get astrologer
  const astrologer = await prisma.astrologer.findUnique({
    where: { id: intake.astrologerId }
  });

  if (!astrologer) throw new Error("Astrologer not found");

  //  Create session
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

  // ATOMIC REDIS OPERATIONS (VERY IMPORTANT)
  const multi = redis.multi();

  //Remove ONLY this roomId from queue (FIX)
  multi.lrem(`chat_queue:${intake.astrologerId}`, 1, roomId);

  //Set active chat with TTL
  multi.set(
    `active_chat:${roomId}`,
    JSON.stringify({
      sessionId: session.id,
      userId: intake.userId,
      astrologerId: intake.astrologerId,
      startTime: Date.now()
    }),
    "EX",
    3600 // 1 hour safety
  );

  //(Optional but recommended) remove request cache
  multi.del(`chat_request:${roomId}`);

  await multi.exec();

  console.log("Chat moved to active:", roomId);

  return session;
};