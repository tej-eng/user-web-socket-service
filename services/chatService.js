// services/chatService.js

export const handleAcceptChat = async (roomId, prisma, redis) => {
  const intake = await prisma.intake.findFirst({
    where: { chatId: roomId }
  });

  if (!intake) throw new Error("Chat request not found");

  const astrologer = await prisma.astrologer.findUnique({
    where: { id: intake.astrologerId }
  });

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

  await redis.lPop(`chat_queue:${intake.astrologerId}`);

  await redis.set(
    `active_chat:${roomId}`,
    JSON.stringify({
      sessionId: session.id,
      userId: intake.userId,
      astrologerId: intake.astrologerId,
      startTime: Date.now()
    })
  );

  return session;
};
