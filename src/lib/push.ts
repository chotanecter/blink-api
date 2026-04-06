import Expo, { type ExpoPushMessage } from "expo-server-sdk";

const expo = new Expo();

export async function sendPushNotifications(
  pushTokens: string[],
  notification: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
  }
) {
  const messages: ExpoPushMessage[] = pushTokens
    .filter((token) => Expo.isExpoPushToken(token))
    .map((token) => ({
      to: token,
      sound: "default" as const,
      title: notification.title,
      body: notification.body,
      data: notification.data || {},
    }));

  if (messages.length === 0) return [];

  const chunks = expo.chunkPushNotifications(messages);
  const results = [];

  for (const chunk of chunks) {
    try {
      const tickets = await expo.sendPushNotificationsAsync(chunk);
      results.push(...tickets);
    } catch (err) {
      console.error("Push notification error:", err);
    }
  }

  return results;
}
