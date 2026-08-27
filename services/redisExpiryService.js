// services/redisExpiryService.js

let expirySubscriber = null;

export const startRedisExpiryService = async (redisClient) => {
  try {
    if (!redisClient) {
      throw new Error("Redis client is required");
    }

    console.log(
      "[Redis Expiry] Starting expiry service..."
    );

    // ------------------------------------------------
    // Create separate Redis connection
    // ------------------------------------------------

    expirySubscriber = redisClient.duplicate();

    expirySubscriber.on("error", (error) => {
      console.error(
        "[Redis Expiry] Subscriber error:",
        error
      );
    });

    expirySubscriber.on("connect", () => {
      console.log(
        "[Redis Expiry] Subscriber connected"
      );
    });

    expirySubscriber.on("ready", () => {
      console.log(
        "[Redis Expiry] Subscriber ready"
      );
    });

    expirySubscriber.on("end", () => {
      console.log(
        "[Redis Expiry] Subscriber connection ended"
      );
    });

    await expirySubscriber.connect();

    console.log(
      "[Redis Expiry] Subscriber Redis connection established"
    );

    // ------------------------------------------------
    // Subscribe to expired keys
    // ------------------------------------------------
    //
    // Using * instead of 0 means:
    // __keyevent@0__:expired
    // __keyevent@1__:expired
    // etc.
    //
    // This avoids DB-number problems.
    // ------------------------------------------------

    await expirySubscriber.pSubscribe(
      "__keyevent@*__:expired",
      async (expiredKey, channel) => {
        try {
          console.log(
            "=========================================="
          );

          console.log(
            "[Redis Expiry] EXPIRED KEY:",
            expiredKey
          );

          console.log(
            "[Redis Expiry] CHANNEL:",
            channel
          );

          console.log(
            "=========================================="
          );

          // ------------------------------------------
          // Only process cleanup keys
          // ------------------------------------------

          if (!expiredKey.startsWith("cleanup_:")) {
            console.log(
              "[Redis Expiry] Ignoring key:",
              expiredKey
            );

            return;
          }

          await handleCleanupKeyExpired(
            redisClient,
            expiredKey
          );
        } catch (error) {
          console.error(
            "[Redis Expiry] Handler error:",
            error
          );
        }
      }
    );

    console.log(
      "[Redis Expiry] =================================="
    );

    console.log(
      "[Redis Expiry] SERVICE STARTED SUCCESSFULLY"
    );

    console.log(
      "[Redis Expiry] Listening for expired keys"
    );

    console.log(
      "[Redis Expiry] Pattern: __keyevent@*__:expired"
    );

    console.log(
      "[Redis Expiry] =================================="
    );
  } catch (error) {
    console.error(
      "[Redis Expiry] Failed to start:",
      error
    );

    throw error;
  }
};


// ==================================================
// HANDLE EXPIRED CLEANUP KEY
// ==================================================

// ==================================================
// HANDLE EXPIRED CLEANUP KEY
// ==================================================

const handleCleanupKeyExpired = async (
  redisClient,
  expiredKey,
) => {
  try {
    console.log(
      "[Redis Cleanup] Processing:",
      expiredKey,
    );

    // =================================================
    // VALIDATE PREFIX
    // =================================================

    const prefix = "cleanup_:";

    if (!expiredKey.startsWith(prefix)) {
      console.log(
        "[Redis Cleanup] Invalid prefix:",
        expiredKey,
      );

      return;
    }

    // =================================================
    // PARSE CLEANUP KEY
    // =================================================

    /**
     * Expected:
     *
     * cleanup_:roomId_astrologerId_userId
     */

    const keyData = expiredKey.substring(
      prefix.length,
    );

    // UUIDs contain "-" but not "_"
    const parts = keyData.split("_");

    if (parts.length !== 3) {
      console.error(
        "[Redis Cleanup] Invalid cleanup key:",
        expiredKey,
      );

      console.error(
        "[Redis Cleanup] Parts:",
        parts,
      );

      return;
    }

    const [
      roomId,
      astrologerId,
      userId,
    ] = parts;

    console.log(
      "[Redis Cleanup] Details:",
      {
        roomId,
        astrologerId,
        userId,
      },
    );

    // =================================================
    // CHECK ASTROLOGER PRESENCE
    // =================================================

    const presenceKey =
      `presence:astro:${astrologerId}`;

    console.log(
      "[Redis Cleanup] Checking presence:",
      presenceKey,
    );

    const presenceData =
      await redisClient.get(presenceKey);

    // =================================================
    // PRESENCE KEY NOT FOUND
    // =================================================

    if (!presenceData) {
      console.log(
        "[Redis Cleanup] Presence key not found:",
        presenceKey,
      );

      console.log(
        "[Redis Cleanup] Cleanup SKIPPED.",
      );

      return;
    }

    // =================================================
    // PARSE PRESENCE DATA
    // =================================================

    let presence;

    try {
      presence = JSON.parse(presenceData);
    } catch (error) {
      console.error(
        "[Redis Cleanup] Invalid presence JSON:",
        presenceData,
      );

      return;
    }

    console.log(
      "[Redis Cleanup] Presence data:",
      presence,
    );

    // =================================================
    // CHECK APP STATE
    // =================================================

    const appState = presence?.appState;

    console.log(
      "[Redis Cleanup] App State:",
      appState,
    );

    // =================================================
    // APP IS NOT BACKGROUND
    // =================================================

    if (appState !== "background" || "inactive") {
      console.log(
        "[Redis Cleanup] App is NOT in background.",
      );

      console.log(
        "[Redis Cleanup] Skipping cleanup.",
      );

      return;
    }

    // =================================================
    // APP IS BACKGROUND
    // =================================================

    console.log(
      "[Redis Cleanup] App is in BACKGROUND.",
    );

    console.log(
      "[Redis Cleanup] Proceeding with cleanup...",
    );

    // =================================================
    // DELETE ROOM RELATED KEYS
    // =================================================

    const keysToDelete = [
      `request_data:${roomId}`,
      `active_chat:${roomId}`,
      `active_call:${roomId}`,
    ];

    console.log(
      "[Redis Cleanup] Deleting keys:",
      keysToDelete,
    );

    const deletedCount =
      await redisClient.del(keysToDelete);

    console.log(
      "[Redis Cleanup] Deleted count:",
      deletedCount,
    );

    // =================================================
    // REMOVE USER FROM QUEUE
    // =================================================

    const queueKey =
      `queue:${astrologerId}`;

    console.log(
      "[Redis Cleanup] Checking queue:",
      queueKey,
    );

    const queueData =
      await redisClient.lRange(
        queueKey,
        0,
        -1,
      );

    console.log(
      "[Redis Cleanup] Queue items:",
      queueData.length,
    );

    for (const item of queueData) {
      try {
        const parsed =
          JSON.parse(item);

        if (
          parsed.roomId === roomId ||
          parsed.room_id === roomId ||
          parsed.user_id === userId
        ) {
          const removed =
            await redisClient.lRem(
              queueKey,
              0,
              item,
            );

          console.log(
            "[Redis Cleanup] Queue item removed:",
            removed,
          );
        }
      } catch (error) {
        console.error(
          "[Redis Cleanup] Invalid queue item:",
          item,
        );
      }
    }

    // =================================================
    // REMOVE USER FROM QUEUE SET
    // =================================================

    const userQueueKey =
      `user_in_queue:${astrologerId}`;

    const removedFromSet =
      await redisClient.sRem(
        userQueueKey,
        userId,
      );

    console.log(
      "[Redis Cleanup] User removed from queue set:",
      removedFromSet,
    );

    // =================================================
    // CLEAR CURRENT CHAT/CALL ONLY IF SAME ROOM
    // =================================================

    const currentChatKey =
      `current_chat:${astrologerId}`;

    const currentCallKey =
      `current_call:${astrologerId}`;

    const [
      currentChatRoom,
      currentCallRoom,
    ] = await Promise.all([
      redisClient.get(currentChatKey),
      redisClient.get(currentCallKey),
    ]);

    if (currentChatRoom === roomId) {
      await redisClient.del(currentChatKey);

      console.log(
        "[Redis Cleanup] Deleted current chat:",
        currentChatKey,
      );
    }

    if (currentCallRoom === roomId) {
      await redisClient.del(currentCallKey);

      console.log(
        "[Redis Cleanup] Deleted current call:",
        currentCallKey,
      );
    }

    // =================================================
    // COMPLETED
    // =================================================

    console.log(
      "[Redis Cleanup] ==================================",
    );

    console.log(
      `[Redis Cleanup] Cleanup completed for room: ${roomId}`,
    );

    console.log(
      "[Redis Cleanup] ==================================",
    );
  } catch (error) {
    console.error(
      "[Redis Cleanup] Error:",
      error,
    );
  }
};