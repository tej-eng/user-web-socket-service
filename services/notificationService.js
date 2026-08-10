import OneSignal from "@onesignal/node-onesignal";

const client = new OneSignal.DefaultApi(
  OneSignal.createConfiguration({
    restApiKey: process.env.ONESIGNAL_REST_API_KEY,
  }),
);

/**
 * Send chat message notification to astrologer
 *
 * - If astrologer is foreground/active:
 *   No push notification will be sent.
 *
 * - If astrologer is background/inactive/disconnected:
 *   OneSignal push notification will be sent.
 */
export const sendChatMessageNotification = async (
  redisClient,
  data,
) => {
  try {
    const receiverId = data.received_id;

    if (!receiverId) {
      console.log(
        "[Chat Notification] No receiverId for message notification",
      );

      return {
        success: false,
        reason: "RECEIVER_ID_NOT_FOUND",
      };
    }

    // ---------------------------------------------
    // Get astrologer presence
    // ---------------------------------------------

    const key = `presence:astro:${receiverId}`;

    const presence = await redisClient.get(key);

    console.log(
      "[Chat Notification] Presence:",
      presence,
    );

    // Astrologer has never connected
    // or presence has expired
    if (!presence) {
      console.log(
        `[Chat Notification] Presence not found for astrologer ${receiverId}`,
      );

      return {
        success: false,
        reason: "PRESENCE_NOT_FOUND",
      };
    }

    let astro;

    try {
      astro = JSON.parse(presence);
    } catch (error) {
      console.error(
        "[Chat Notification] Invalid presence JSON:",
        error,
      );

      return {
        success: false,
        reason: "INVALID_PRESENCE",
      };
    }

    console.log(
      "[Chat Notification] Astrologer presence:",
      astro,
    );

    // ---------------------------------------------
    // Check foreground/background
    // ---------------------------------------------

    const isForeground =
      astro.online === true &&
      astro.appState === "foreground" &&
      !!astro.socketId;

    // ---------------------------------------------
    // FOREGROUND
    // ---------------------------------------------

    if (isForeground) {
      console.log(
        `[Chat Notification] Astrologer ${receiverId} is foreground. Skipping push notification.`,
      );

      return {
        success: false,
        reason: "ACTIVE_ON_SOCKET",
      };
    }

    // ---------------------------------------------
    // BACKGROUND / INACTIVE / DISCONNECTED
    // ---------------------------------------------

    console.log(
      `[Chat Notification] Astrologer ${receiverId} is background/inactive/disconnected. Sending push.`,
    );

    const title =
      data.sender === "User"
        ? "New Chat Message"
        : "New Message";

    const message =
      data.message ||
      "You have a new message";

    const notificationData = {
      type: "chat_message",

      room_id: data.room_id,

      sender_id: data.sender_id,

      received_id: data.received_id,

      message: data.message || "",

      msg_id: data.msg_id,

      sender: data.sender || "User",
    };

    return await sendAstrologerNotification(
      redisClient,
      receiverId,
      title,
      message,
      notificationData,
    );
  } catch (error) {
    console.error(
      "[Chat Notification] Error:",
      error,
    );

    return {
      success: false,
      reason: "CHAT_NOTIFICATION_ERROR",
      error: error.message,
    };
  }
};


/**
 * Send notification to astrologer using OneSignal
 */
export async function sendAstrologerNotification(
  redisClient,
  astroId,
  title,
  message,
  data,
) {
  try {
    const key = `presence:astro:${astroId}`;

    const presence = await redisClient.get(key);

    // ---------------------------------------------
    // Presence not found
    // ---------------------------------------------

    if (!presence) {
      console.log(
        `[Notification] Presence not found for astrologer ${astroId}`,
      );

      return {
        success: false,
        reason: "PRESENCE_NOT_FOUND",
      };
    }

    let astro;

    try {
      astro = JSON.parse(presence);
    } catch (error) {
      console.error(
        `[Notification] Invalid presence JSON for astrologer ${astroId}`,
        error,
      );

      return {
        success: false,
        reason: "INVALID_PRESENCE",
      };
    }

    console.log(
      `[Notification] Astrologer ${astroId} presence:`,
      astro,
    );

    // ---------------------------------------------
    // Check whether push is required
    // ---------------------------------------------

    const shouldNotify =
      !astro.online ||
      astro.appState === "background" ||
      astro.appState === "inactive" ||
      !astro.socketId;

    // ---------------------------------------------
    // FOREGROUND / ACTIVE
    // ---------------------------------------------

    if (!shouldNotify) {
      console.log(
        `[Notification] Astrologer ${astroId} is active. Skipping push notification.`,
      );

      return {
        success: false,
        reason: "ACTIVE_ON_SOCKET",
      };
    }

    // ---------------------------------------------
    // Player ID
    // ---------------------------------------------

    if (!astro.playerId) {
      console.log(
        `[Notification] Player ID not found for astrologer ${astroId}`,
      );

      return {
        success: false,
        reason: "PLAYER_ID_NOT_FOUND",
      };
    }

    console.log(
      "[Notification] Player ID:",
      astro.playerId,
    );

    console.log(
      "[Notification] Title:",
      title,
    );

    console.log(
      "[Notification] Message:",
      message,
    );

    console.log(
      "[Notification] Data:",
      data,
    );

    // ---------------------------------------------
    // OneSignal Push
    // ---------------------------------------------

    await client.createNotification({
      app_id: process.env.ONESIGNAL_APP_ID,

      include_subscription_ids: [
        astro.playerId,
      ],

      headings: {
        en: title,
      },

      contents: {
        en: message,
      },

      data,
    });

    console.log(
      `[Notification] Push sent successfully to astrologer ${astroId}`,
    );

    return {
      success: true,
      reason: "PUSH_SENT",
    };
  } catch (err) {
    console.error(
      "[Notification] OneSignal Notification Error:",
      err,
    );

    return {
      success: false,
      reason: "ONESIGNAL_ERROR",
      error: err.message,
    };
  }
}