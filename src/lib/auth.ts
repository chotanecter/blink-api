import jwt from "jsonwebtoken";
import type { Context, Next } from "hono";

const SECRET = process.env.JWT_SECRET || "dev-secret";

export interface InfluencerPayload {
  influencer_id: string;
  email: string;
}

export interface DevicePayload {
  device_id: string;
  influencer_id: string;
}

export function signInfluencerToken(payload: InfluencerPayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: "30d" });
}

export function signDeviceToken(payload: DevicePayload): string {
  return jwt.sign(payload, SECRET, { expiresIn: "365d" });
}

export function verifyToken<T = InfluencerPayload | DevicePayload>(
  token: string
): T {
  return jwt.verify(token, SECRET) as T;
}

export async function influencerAuth(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization header" }, 401);
  }
  try {
    const payload = verifyToken<InfluencerPayload>(header.slice(7));
    if (!payload.influencer_id) {
      return c.json({ error: "Invalid token type" }, 401);
    }
    c.set("influencer", payload);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}

export async function deviceAuth(c: Context, next: Next) {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid authorization header" }, 401);
  }
  try {
    const payload = verifyToken<DevicePayload>(header.slice(7));
    if (!payload.device_id) {
      return c.json({ error: "Invalid token type" }, 401);
    }
    c.set("device", payload);
    await next();
  } catch {
    return c.json({ error: "Invalid or expired token" }, 401);
  }
}
