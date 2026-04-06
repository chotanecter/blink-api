import {
  pgTable,
  uuid,
  varchar,
  text,
  timestamp,
  integer,
  jsonb,
  real,
} from "drizzle-orm/pg-core";

export const influencers = pgTable("influencers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  slug: varchar("slug", { length: 255 }).notNull().unique(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  brandColor: varchar("brand_color", { length: 7 }).default("#FF00FF"),
  nfcBaseUrl: text("nfc_base_url"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const devices = pgTable("devices", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: varchar("device_id", { length: 64 }).notNull().unique(),
  influencerId: uuid("influencer_id")
    .references(() => influencers.id)
    .notNull(),
  firmwareVersion: varchar("firmware_version", { length: 32 }),
  hardwareVersion: varchar("hardware_version", { length: 32 }),
  pairingCode: varchar("pairing_code", { length: 16 }),
  deviceToken: text("device_token"),
  mode: varchar("mode", { length: 8 }).default("wifi"),
  batteryPercent: integer("battery_percent"),
  batteryVoltage: real("battery_voltage"),
  lastSeen: timestamp("last_seen"),
  pushToken: text("push_token"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const notifications = pgTable("notifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  influencerId: uuid("influencer_id")
    .references(() => influencers.id)
    .notNull(),
  type: varchar("type", { length: 16 }).notNull(), // 'pulse' | 'content'
  payload: jsonb("payload").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const notificationDeliveries = pgTable("notification_deliveries", {
  id: uuid("id").defaultRandom().primaryKey(),
  notificationId: uuid("notification_id")
    .references(() => notifications.id)
    .notNull(),
  deviceId: uuid("device_id")
    .references(() => devices.id)
    .notNull(),
  deliveredAt: timestamp("delivered_at"),
  ackedAt: timestamp("acked_at"),
});

export const feedback = pgTable("feedback", {
  id: uuid("id").defaultRandom().primaryKey(),
  deviceId: uuid("device_id")
    .references(() => devices.id)
    .notNull(),
  notificationId: uuid("notification_id").references(() => notifications.id),
  action: varchar("action", { length: 64 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
