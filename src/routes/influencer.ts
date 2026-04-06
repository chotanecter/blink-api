import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../lib/db";
import {
  devices,
  notifications,
  notificationDeliveries,
  feedback as feedbackTable,
} from "../lib/db/schema";
import { influencerAuth, type InfluencerPayload } from "../lib/auth";
import { publishNotification } from "../lib/mqtt";
import { sendPushNotifications } from "../lib/push";
import { eq, and, count, sql, desc, isNotNull, lt } from "drizzle-orm";

type Variables = {
  influencer: InfluencerPayload;
};

const influencer = new Hono<{ Variables: Variables }>();

influencer.use("/*", influencerAuth);

const pulseSchema = z.object({
  color: z.string().default("#FF00FF"),
  pattern: z.string().default("solid"),
  duration: z.number().int().min(100).max(30000).default(3000),
  buzzer: z.boolean().default(false),
});

const contentSchema = z.object({
  title: z.string().min(1),
  content_url: z.string().url(),
  content_type: z.string().default("link"),
  color: z.string().default("#FF00FF"),
  pattern: z.string().default("pulse"),
});

influencer.post("/pulse", zValidator("json", pulseSchema), async (c) => {
  const payload = c.req.valid("json");
  const auth = c.get("influencer") as InfluencerPayload;

  // Save notification
  const [notification] = await db
    .insert(notifications)
    .values({
      influencerId: auth.influencer_id,
      type: "pulse",
      payload,
    })
    .returning();

  // Create delivery records for all devices
  const deviceList = await db
    .select()
    .from(devices)
    .where(eq(devices.influencerId, auth.influencer_id));

  if (deviceList.length > 0) {
    await db.insert(notificationDeliveries).values(
      deviceList.map((d) => ({
        notificationId: notification.id,
        deviceId: d.id,
      }))
    );
  }

  // Publish to MQTT
  publishNotification(auth.influencer_id, "notify", {
    notification_id: notification.id,
    type: "pulse",
    ...payload,
  });

  // Send push to BLE-mode devices
  const bleDevices = deviceList.filter(
    (d) => d.mode === "ble" && d.pushToken
  );
  if (bleDevices.length > 0) {
    await sendPushNotifications(
      bleDevices.map((d) => d.pushToken!),
      {
        title: "Blink Pulse!",
        body: "New pulse from your creator",
        data: {
          notification_id: notification.id,
          type: "pulse",
          ...payload,
        },
      }
    );
  }

  return c.json({
    ok: true,
    notification_id: notification.id,
    devices_reached: deviceList.length,
    ble_push_sent: bleDevices.length,
  });
});

influencer.post("/content", zValidator("json", contentSchema), async (c) => {
  const payload = c.req.valid("json");
  const auth = c.get("influencer") as InfluencerPayload;

  const [notification] = await db
    .insert(notifications)
    .values({
      influencerId: auth.influencer_id,
      type: "content",
      payload,
    })
    .returning();

  const deviceList = await db
    .select()
    .from(devices)
    .where(eq(devices.influencerId, auth.influencer_id));

  if (deviceList.length > 0) {
    await db.insert(notificationDeliveries).values(
      deviceList.map((d) => ({
        notificationId: notification.id,
        deviceId: d.id,
      }))
    );
  }

  publishNotification(auth.influencer_id, "content", {
    notification_id: notification.id,
    type: "content",
    ...payload,
  });

  const bleDevices = deviceList.filter(
    (d) => d.mode === "ble" && d.pushToken
  );
  if (bleDevices.length > 0) {
    await sendPushNotifications(
      bleDevices.map((d) => d.pushToken!),
      {
        title: payload.title,
        body: "New content from your creator",
        data: {
          notification_id: notification.id,
          type: "content",
          ...payload,
        },
      }
    );
  }

  return c.json({
    ok: true,
    notification_id: notification.id,
    devices_reached: deviceList.length,
    ble_push_sent: bleDevices.length,
  });
});

influencer.get("/audience", async (c) => {
  const auth = c.get("influencer") as InfluencerPayload;
  const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);

  const [totals] = await db
    .select({ total: count() })
    .from(devices)
    .where(eq(devices.influencerId, auth.influencer_id));

  const [online] = await db
    .select({ count: count() })
    .from(devices)
    .where(
      and(
        eq(devices.influencerId, auth.influencer_id),
        sql`${devices.lastSeen} > ${fiveMinAgo}`
      )
    );

  const [batteryLow] = await db
    .select({ count: count() })
    .from(devices)
    .where(
      and(
        eq(devices.influencerId, auth.influencer_id),
        isNotNull(devices.batteryPercent),
        lt(devices.batteryPercent, 20)
      )
    );

  // Ack rate: acked deliveries / total deliveries
  const [totalDeliveries] = await db
    .select({ count: count() })
    .from(notificationDeliveries)
    .innerJoin(devices, eq(notificationDeliveries.deviceId, devices.id))
    .where(eq(devices.influencerId, auth.influencer_id));

  const [ackedDeliveries] = await db
    .select({ count: count() })
    .from(notificationDeliveries)
    .innerJoin(devices, eq(notificationDeliveries.deviceId, devices.id))
    .where(
      and(
        eq(devices.influencerId, auth.influencer_id),
        isNotNull(notificationDeliveries.ackedAt)
      )
    );

  const ackRate =
    totalDeliveries.count > 0
      ? ackedDeliveries.count / totalDeliveries.count
      : 0;

  return c.json({
    total_devices: totals.total,
    online: online.count,
    battery_low: batteryLow.count,
    ack_rate: Math.round(ackRate * 100) / 100,
  });
});

influencer.get("/feedback", async (c) => {
  const auth = c.get("influencer") as InfluencerPayload;

  const results = await db
    .select({
      id: feedbackTable.id,
      device_id: devices.deviceId,
      notification_id: feedbackTable.notificationId,
      action: feedbackTable.action,
      created_at: feedbackTable.createdAt,
    })
    .from(feedbackTable)
    .innerJoin(devices, eq(feedbackTable.deviceId, devices.id))
    .where(eq(devices.influencerId, auth.influencer_id))
    .orderBy(desc(feedbackTable.createdAt))
    .limit(100);

  return c.json({ feedback: results });
});

influencer.get("/notifications", async (c) => {
  const auth = c.get("influencer") as InfluencerPayload;

  const results = await db
    .select()
    .from(notifications)
    .where(eq(notifications.influencerId, auth.influencer_id))
    .orderBy(desc(notifications.createdAt))
    .limit(50);

  return c.json({ notifications: results });
});

export default influencer;
