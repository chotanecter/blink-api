import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../lib/db";
import { devices, influencers, notifications, notificationDeliveries, feedback as feedbackTable } from "../lib/db/schema";
import { signDeviceToken, deviceAuth } from "../lib/auth";
import { eq, and, gt, inArray } from "drizzle-orm";

const devicesRouter = new Hono();

const registerSchema = z.object({
  device_id: z.string().min(1),
  pairing_code: z.string().min(1),
  firmware_version: z.string().optional(),
  hardware_version: z.string().optional(),
});

const heartbeatSchema = z.object({
  device_id: z.string().min(1),
  battery_percent: z.number().int().min(0).max(100).optional(),
  battery_voltage: z.number().optional(),
  mode: z.enum(["wifi", "ble"]).optional(),
  rssi: z.number().optional(),
});

const ackSchema = z.object({
  device_id: z.string().min(1),
  notification_ids: z.array(z.string().uuid()),
});

const feedbackSchema = z.object({
  device_id: z.string().min(1),
  notification_id: z.string().uuid().optional(),
  action: z.string().min(1),
});

const pushTokenSchema = z.object({
  device_id: z.string().min(1),
  push_token: z.string().min(1),
});

// Manufacturer test pairing code — allows any device to auto-register
const MANUFACTURER_TEST_CODE = "BLINK-MFG-TEST";

devicesRouter.post(
  "/register",
  zValidator("json", registerSchema),
  async (c) => {
    const { device_id, pairing_code, firmware_version, hardware_version } =
      c.req.valid("json");

    // Find device by device_id + pairing_code
    let [existing] = await db
      .select()
      .from(devices)
      .where(
        and(
          eq(devices.deviceId, device_id),
          eq(devices.pairingCode, pairing_code)
        )
      )
      .limit(1);

    // Manufacturer test mode: auto-register unknown devices with test code
    if (!existing && pairing_code === MANUFACTURER_TEST_CODE) {
      // Check if this device_id already exists (registered with different code)
      const [existingById] = await db
        .select()
        .from(devices)
        .where(eq(devices.deviceId, device_id))
        .limit(1);

      if (existingById) {
        existing = existingById;
      } else {
        // Find or create the "Test Artist" influencer for manufacturer testing
        let [testInf] = await db
          .select()
          .from(influencers)
          .where(eq(influencers.slug, "test-artist"))
          .limit(1);

        if (!testInf) {
          // Look for any influencer with "test" in the slug
          [testInf] = await db
            .select()
            .from(influencers)
            .limit(1);
        }

        if (!testInf) {
          return c.json({ error: "No influencer available for test registration" }, 500);
        }

        // Auto-create the device
        const [newDevice] = await db
          .insert(devices)
          .values({
            deviceId: device_id,
            influencerId: testInf.id,
            pairingCode: MANUFACTURER_TEST_CODE,
            firmwareVersion: firmware_version || "1.0.0",
            hardwareVersion: hardware_version || "unknown",
            mode: "wifi",
            lastSeen: new Date(),
          })
          .returning();

        existing = newDevice;
        console.log(`[MFG-TEST] Auto-registered device ${device_id} -> influencer ${testInf.id}`);
      }
    }

    if (!existing) {
      return c.json({ error: "Invalid device ID or pairing code" }, 404);
    }

    const deviceToken = signDeviceToken({
      device_id: existing.deviceId,
      influencer_id: existing.influencerId,
    });

    await db
      .update(devices)
      .set({
        deviceToken,
        firmwareVersion: firmware_version || existing.firmwareVersion,
        hardwareVersion: hardware_version || existing.hardwareVersion,
        lastSeen: new Date(),
      })
      .where(eq(devices.id, existing.id));

    // Public MQTT connection info for external devices
    // TCP proxy: nozomi.proxy.rlwy.net:24799 → internal :1883
    // WSS: wss://blink-api-production-267f.up.railway.app (shares HTTPS port)
    const publicHost = process.env.MQTT_PUBLIC_HOST || c.req.header("Host")?.split(":")[0] || "localhost";
    const publicPort = parseInt(process.env.MQTT_PUBLIC_PORT || process.env.MQTT_PORT || "1883");
    const wsHost = process.env.MQTT_WS_HOST || c.req.header("Host")?.split(":")[0] || "localhost";
    const wsPort = parseInt(process.env.MQTT_WS_PUBLIC_PORT || "443");

    return c.json({
      device_token: deviceToken,
      artist_id: existing.influencerId,
      mqtt: {
        host: publicHost,
        port: publicPort,
        ws_host: wsHost,
        ws_port: wsPort,
        use_tls: wsPort === 443,
        username: existing.deviceId,
        topics: {
          notify: `fp/${existing.influencerId}/notify`,
          content: `fp/${existing.influencerId}/content`,
          events: `blink/${existing.influencerId}/events`,
          command: `fp/device/${existing.deviceId}/command`,
          status: `fp/device/${existing.deviceId}/status`,
          feedback: `fp/device/${existing.deviceId}/feedback`,
        },
      },
      influencer: {
        id: existing.influencerId,
      },
    });
  }
);

devicesRouter.post(
  "/heartbeat",
  zValidator("json", heartbeatSchema),
  async (c) => {
    const { device_id, battery_percent, battery_voltage, mode } =
      c.req.valid("json");

    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, device_id))
      .limit(1);

    if (!device) {
      return c.json({ error: "Device not found" }, 404);
    }

    await db
      .update(devices)
      .set({
        batteryPercent: battery_percent ?? device.batteryPercent,
        batteryVoltage: battery_voltage ?? device.batteryVoltage,
        mode: mode ?? device.mode,
        lastSeen: new Date(),
      })
      .where(eq(devices.id, device.id));

    // Count pending (unacked) notifications
    const pending = await db
      .select({ id: notificationDeliveries.id })
      .from(notificationDeliveries)
      .where(
        and(
          eq(notificationDeliveries.deviceId, device.id),
          eq(notificationDeliveries.ackedAt, null as any)
        )
      );

    return c.json({
      ok: true,
      pending_notifications: pending.length,
      ota: null, // placeholder for OTA info
    });
  }
);

devicesRouter.get("/:device_id/notifications", async (c) => {
  const deviceId = c.req.param("device_id");
  const since = c.req.query("since");

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.deviceId, deviceId))
    .limit(1);

  if (!device) {
    return c.json({ error: "Device not found" }, 404);
  }

  let query = db
    .select({
      id: notifications.id,
      type: notifications.type,
      payload: notifications.payload,
      created_at: notifications.createdAt,
    })
    .from(notifications)
    .where(
      since
        ? and(
            eq(notifications.influencerId, device.influencerId),
            gt(notifications.createdAt, new Date(since))
          )
        : eq(notifications.influencerId, device.influencerId)
    )
    .orderBy(notifications.createdAt)
    .limit(50);

  const results = await query;
  return c.json({ notifications: results });
});

devicesRouter.post("/ack", zValidator("json", ackSchema), async (c) => {
  const { device_id, notification_ids } = c.req.valid("json");

  const [device] = await db
    .select()
    .from(devices)
    .where(eq(devices.deviceId, device_id))
    .limit(1);

  if (!device) {
    return c.json({ error: "Device not found" }, 404);
  }

  if (notification_ids.length > 0) {
    await db
      .update(notificationDeliveries)
      .set({ ackedAt: new Date() })
      .where(
        and(
          eq(notificationDeliveries.deviceId, device.id),
          inArray(notificationDeliveries.notificationId, notification_ids)
        )
      );
  }

  return c.json({ ok: true, acked: notification_ids.length });
});

devicesRouter.post(
  "/feedback",
  zValidator("json", feedbackSchema),
  async (c) => {
    const { device_id, notification_id, action } = c.req.valid("json");

    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, device_id))
      .limit(1);

    if (!device) {
      return c.json({ error: "Device not found" }, 404);
    }

    await db.insert(feedbackTable).values({
      deviceId: device.id,
      notificationId: notification_id || null,
      action,
    });

    return c.json({ ok: true });
  }
);

devicesRouter.post(
  "/push-token",
  zValidator("json", pushTokenSchema),
  async (c) => {
    const { device_id, push_token } = c.req.valid("json");

    const [device] = await db
      .select()
      .from(devices)
      .where(eq(devices.deviceId, device_id))
      .limit(1);

    if (!device) {
      return c.json({ error: "Device not found" }, 404);
    }

    await db
      .update(devices)
      .set({ pushToken: push_token })
      .where(eq(devices.id, device.id));

    return c.json({ ok: true });
  }
);

export default devicesRouter;
