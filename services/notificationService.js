import OneSignal from "@onesignal/node-onesignal";

const client = new OneSignal.DefaultApi(
  OneSignal.createConfiguration({
    restApiKey: process.env.ONESIGNAL_REST_API_KEY,
  })
);

export async function sendAstrologerNotification(
  redisClient,
  astroId,
  title,
  message,
  data
) {
  try {
    const key = `presence:astro:${astroId}`;
    const presence = await redisClient.get(key);

    // Astrologer has never connected or presence expired
    if (!presence) {
      console.log(`[Notification] Presence not found for astrologer ${astroId}`);
      return {
        success: false,
        reason: "PRESENCE_NOT_FOUND",
      };
    }

    const astro = JSON.parse(presence);

    const shouldNotify =
      !astro.online ||
      astro.appState === "background" ||
      astro.appState === "inactive" ||
      !astro.socketId;

    if (!shouldNotify) {
      console.log(
        `[Notification] Astrologer ${astroId} is active. Skipping push notification.`
      );

      return {
        success: false,
        reason: "ACTIVE_ON_SOCKET",
      };
    }

    if (!astro.playerId) {
      console.log(
        `[Notification] Player ID not found for astrologer ${astroId}`
      );

      return {
        success: false,
        reason: "PLAYER_ID_NOT_FOUND",
      };
    }

    await client.createNotification({
      app_id: process.env.ONESIGNAL_APP_ID,

      include_player_ids: [astro.playerId],

      headings: {
        en: title,
      },

      contents: {
        en: message,
      },

      data,
    });

    console.log(
      `[Notification] Push sent successfully to astrologer ${astroId}`
    );

    return {
      success: true,
      reason: "PUSH_SENT",
    };
  } catch (err) {
    console.error("OneSignal Notification Error:", err);

    return {
      success: false,
      reason: "ONESIGNAL_ERROR",
      error: err.message,
    };
  }
}