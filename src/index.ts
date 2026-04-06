import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

import authRoutes from "./routes/auth";
import deviceRoutes from "./routes/devices";
import influencerRoutes from "./routes/influencer";
import otaRoutes from "./routes/ota";
import testRoutes from "./routes/test";
import { startMqttBroker, getMqttWsServer } from "./lib/mqtt";

const app = new Hono();

// Middleware
app.use("*", logger());
app.use("*", cors());

// Health check
app.get("/", (c) => c.json({ service: "blink-api", status: "ok" }));
app.get("/health", (c) => c.json({ status: "ok" }));

// API routes
app.route("/api/v1/auth", authRoutes);
app.route("/api/v1/devices", deviceRoutes);
app.route("/api/v1/influencer", influencerRoutes);
app.route("/api/v1/ota", otaRoutes);
app.route("/api/v1/test", testRoutes);

// Start MQTT broker (creates TCP + WS servers)
startMqttBroker();

// Start HTTP server — MQTT WS and Hono share the same port.
// The WS server handles upgrade requests for MQTT; everything else goes to Hono.
const port = parseInt(process.env.PORT || "3000");
const httpServer = getMqttWsServer()!;

// Route non-WebSocket HTTP requests to Hono
httpServer.on("request", (req, res) => {
  // websocket-stream already attached an \"upgrade\" listener,
  // so regular HTTP requests fall through here to Hono
  app.fetch(
    new Request(`http://localhost:${port}${req.url}`, {
      method: req.method,
      headers: Object.fromEntries(
        Object.entries(req.headers).filter(([, v]) => v !== undefined) as [string, string][]
      ),
      body: ["GET", "HEAD"].includes(req.method!) ? undefined : (req as any),
      // @ts-ignore duplex needed for streaming body
      duplex: "half",
    })
  ).then((response) => {
    res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
    if (response.body) {
      const reader = response.body.getReader();
      const pump = () =>
        reader.read().then(({ done, value }) => {
          if (done) {
            res.end();
            return;
          }
          res.write(value);
          pump();
        });
      pump();
    } else {
      res.end();
    }
  });
});

httpServer.listen(port, () => {
  console.log(`Blink API + MQTT WS listening on port ${port}`);
});
