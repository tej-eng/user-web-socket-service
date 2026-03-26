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

  multi.lRem(`chat_queue:${intake.astrologerId}`, 1, roomId);

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

  multi.del(`chat_request:${roomId}`);

  await multi.exec();

  console.log("Chat moved to active:", roomId);

  return session;
};