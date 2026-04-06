import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../lib/db";
import { influencers } from "../lib/db/schema";
import { signInfluencerToken } from "../lib/auth";
import { eq } from "drizzle-orm";

const auth = new Hono();

const registerSchema = z.object({
  name: z.string().min(1).max(255),
  email: z.string().email(),
  password: z.string().min(8),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

auth.post("/register", zValidator("json", registerSchema), async (c) => {
  const { name, email, password } = c.req.valid("json");

  const existing = await db
    .select({ id: influencers.id })
    .from(influencers)
    .where(eq(influencers.email, email))
    .limit(1);

  if (existing.length > 0) {
    return c.json({ error: "Email already registered" }, 409);
  }

  const passwordHash = await Bun.password.hash(password, {
    algorithm: "bcrypt",
    cost: 10,
  });

  const slug = slugify(name) + "-" + Date.now().toString(36);

  const [influencer] = await db
    .insert(influencers)
    .values({
      name,
      slug,
      email,
      passwordHash,
    })
    .returning({ id: influencers.id, name: influencers.name, email: influencers.email, slug: influencers.slug });

  const token = signInfluencerToken({
    influencer_id: influencer.id,
    email: influencer.email,
  });

  return c.json({
    token,
    influencer: {
      id: influencer.id,
      name: influencer.name,
      email: influencer.email,
      slug: influencer.slug,
    },
  }, 201);
});

auth.post("/login", zValidator("json", loginSchema), async (c) => {
  const { email, password } = c.req.valid("json");

  const [influencer] = await db
    .select()
    .from(influencers)
    .where(eq(influencers.email, email))
    .limit(1);

  if (!influencer) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const valid = await Bun.password.verify(password, influencer.passwordHash);
  if (!valid) {
    return c.json({ error: "Invalid email or password" }, 401);
  }

  const token = signInfluencerToken({
    influencer_id: influencer.id,
    email: influencer.email,
  });

  return c.json({
    token,
    influencer: {
      id: influencer.id,
      name: influencer.name,
      email: influencer.email,
      slug: influencer.slug,
    },
  });
});

export default auth;
