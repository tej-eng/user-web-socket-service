// services/redisExpiryService.js

let expirySubscriber = null;

export const startRedisExpiryService = async (redisClient) => {
  try {
    if (!redisClient) {
      throw new Error("Redis client is required");
    }

    // Create a separate Redis connection for subscriptions.
    // IMPORTANT: Do not use the normal redisClient for subscribe.
    expirySubscriber = redisClient.duplicate();

    expirySubscriber.on("error", (error) => {
      console.error(
        "Redis expiry subscriber error:",
        error
      );
    });

    expirySubscriber.on("connect", () => {
      console.log(
        "Redis expiry subscriber connected"
      );
    });

    expirySubscriber.on("ready", () => {
      console.log(
        "Redis expiry subscriber ready"
      );
    });

    await expirySubscriber.connect();

    // Listen for expired keys from Redis DB 0
    await expirySubscriber.pSubscribe(
      "__keyevent@0__:expired",
      async (expiredKey) => {
        try {
          console.log(
            "======================================"
          );
          console.log(
            "Redis key expired:",
            expiredKey
          );
          console.log(
            "======================================"
          );

          // We only want our cleanup keys
          if (!expiredKey.startsWith("cleanup_:")) {
            return;
          }

          await handleCleanupKeyExpired(
            redisClient,
            expiredKey
          );
        } catch (error) {
          console.error(
            "Error handling expired Redis key:",
            error
          );
        }
      }
    );

    console.log(
      "Redis expiry service started successfully"
    );

    console.log(
      "Listening on: __keyevent@0__:expired"
    );
  } catch (error) {
    console.error(
      "Failed to start Redis expiry service:",
      error
    );

    throw error;
  }
};


const handleCleanupKeyExpired = async (
  redisClient,
  expiredKey
) => {
  try {
    /**
     * Expected key:
     *
     * cleanup_:roomId_astrologerId_userId
     *
     * Example:
     *
     * cleanup_:11633b03-6b63-4623-8afc-853381c6f357_61c912fa-2be4-41be-bcf7-93b7daecc961_30143e6c-4554-44d7-9e5f-62c95b19cd93
     */

    const prefix = "cleanup_:";

    const keyData = expiredKey.substring(
      prefix.length
    );

    const parts = keyData.split("_");

    if (parts.length < 3) {
      console.error(
        "Invalid cleanup key format:",
        expiredKey
      );

      return;
    }

    const roomId = parts[0];
    const astrologerId = parts[1];
    const userId = parts[2];

    console.log(
      "Cleanup information:",
      {
        roomId,
        astrologerId,
        userId,
      }
    );

    // ------------------------------------------
    // DESTROY / DELETE RELATED REDIS KEYS
    // ------------------------------------------

    const keysToDelete = [
      `request_data:${roomId}`,
      `active_chat:${roomId}`,
      `current_chat:${astrologerId}`,
    ];

    console.log(
      "Deleting Redis keys:",
      keysToDelete
    );

    if (keysToDelete.length > 0) {
      await redisClient.del(keysToDelete);
    }

    // ------------------------------------------
    // Remove user from astrologer's queue
    // ------------------------------------------

    const queueKey =
      `queue:${astrologerId}`;

    const queueData =
      await redisClient.lRange(
        queueKey,
        0,
        -1
      );

    for (const item of queueData) {
      try {
        const parsed =
          JSON.parse(item);

        if (
          parsed.roomId === roomId ||
          parsed.user_id === userId
        ) {
          await redisClient.lRem(
            queueKey,
            0,
            item
          );

          console.log(
            "Removed item from queue:",
            item
          );
        }
      } catch (error) {
        console.error(
          "Invalid queue item:",
          item
        );
      }
    }

    // ------------------------------------------
    // Remove user from queue set if required
    // ------------------------------------------

    await redisClient.sRem(
      `user_in_queue:${astrologerId}`,
      userId
    );

    console.log(
      `Cleanup completed for roomId: ${roomId}`
    );
  } catch (error) {
    console.error(
      "handleCleanupKeyExpired error:",
      error
    );
  }
};