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

const handleCleanupKeyExpired = async (
  redisClient,
  expiredKey
) => {
  try {
    console.log(
      "[Redis Cleanup] Processing:",
      expiredKey
    );

    /**
     * Expected:
     *
     * cleanup_:roomId_astrologerId_userId
     *
     * Example:
     *
     * cleanup_:11633b03-6b63-4623-8afc-853381c6f357_61c912fa-2be4-41be-bcf7-93b7daecc961_30143e6c-4554-44d7-9e5f-62c95b19cd93
     */

    const prefix = "cleanup_:";

    if (!expiredKey.startsWith(prefix)) {
      console.log(
        "[Redis Cleanup] Invalid prefix:",
        expiredKey
      );

      return;
    }

    const keyData = expiredKey.substring(
      prefix.length
    );

    // UUIDs contain "-" and not "_", so this is safe
    const parts = keyData.split("_");

    if (parts.length !== 3) {
      console.error(
        "[Redis Cleanup] Invalid cleanup key:",
        expiredKey
      );

      console.error(
        "[Redis Cleanup] Parts:",
        parts
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
      }
    );

    // =================================================
    // DELETE ROOM RELATED KEYS
    // =================================================

    const keysToDelete = [
      `request_data:${roomId}`,
      `active_chat:${roomId}`,
      //`current_chat:${astrologerId}`,
    ];

    console.log(
      "[Redis Cleanup] Deleting keys:",
      keysToDelete
    );

    if (keysToDelete.length > 0) {
      const deletedCount =
        await redisClient.del(keysToDelete);

      console.log(
        "[Redis Cleanup] Deleted count:",
        deletedCount
      );
    }

    // =================================================
    // REMOVE USER FROM QUEUE
    // =================================================

    const queueKey =
      `queue:${astrologerId}`;

    console.log(
      "[Redis Cleanup] Checking queue:",
      queueKey
    );

    const queueData =
      await redisClient.lRange(
        queueKey,
        0,
        -1
      );

    console.log(
      "[Redis Cleanup] Queue items:",
      queueData.length
    );

    for (const item of queueData) {
      try {
        const parsed =
          JSON.parse(item);

        if (
          parsed.roomId === roomId ||
          parsed.user_id === userId
        ) {
          const removed =
            await redisClient.lRem(
              queueKey,
              0,
              item
            );

          console.log(
            "[Redis Cleanup] Queue item removed:",
            removed
          );
        }
      } catch (error) {
        console.error(
          "[Redis Cleanup] Invalid queue item:",
          item
        );
      }
    }

    // =================================================
    // REMOVE USER FROM QUEUE SET
    // =================================================

    const userQueueKey =
      `user_in_queue`;

    const removedFromSet =
      await redisClient.sRem(
        userQueueKey,
        userId
      );

    console.log(
      "[Redis Cleanup] User removed from queue set:",
      removedFromSet
    );

    console.log(
      "[Redis Cleanup] =================================="
    );

    console.log(
      `[Redis Cleanup] Cleanup completed for room: ${roomId}`
    );

    console.log(
      "[Redis Cleanup] =================================="
    );
  } catch (error) {
    console.error(
      "[Redis Cleanup] Error:",
      error
    );
  }
};