import Aedes from "aedes";
import { createServer } from "net";
import { createServer as createHttpServer, type Server as HttpServer } from "http";
import { verifyToken, type DevicePayload } from "./auth";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ws = require("websocket-stream") as any;

let aedesInstance: Aedes | null = null;
let wsHttpServer: HttpServer | null = null;

export function getAedes(): Aedes {
  if (!aedesInstance) {
    throw new Error("MQTT broker not started");
  }
  return aedesInstance;
}

/** Returns the HTTP server used for MQTT WebSocket so Hono can share it */
export function getMqttWsServer(): HttpServer | null {
  return wsHttpServer;
}

export function startMqttBroker() {
  const aedes = new Aedes();
  aedesInstance = aedes;

  // Authenticate devices via JWT
  aedes.authenticate = (client, username, password, callback) => {
    if (!username || !password) {
      return callback(new Error("Missing credentials") as any, false);
    }
    try {
      const payload = verifyToken<DevicePayload>(password.toString());
      if (payload.device_id !== username) {
        return callback(new Error("Device ID mismatch") as any, false);
      }
      callback(null, true);
    } catch {
      callback(new Error("Invalid token") as any, false);
    }
  };

  // TCP broker (in-process, port 1883 — reachable internally or via TCP proxy)
  const tcpPort = parseInt(process.env.MQTT_PORT || "1883");
  const tcpServer = createServer(aedes.handle);
  tcpServer.listen(tcpPort, () => {
    console.log(`MQTT TCP broker listening on port ${tcpPort}`);
  });

  // WebSocket broker — shares the main HTTP port (attached in index.ts)
  // We create the http server here; index.ts will call .listen() on it
  wsHttpServer = createHttpServer();
  ws.createServer({ server: wsHttpServer }, aedes.handle as any);
  console.log("MQTT WebSocket broker attached (will share HTTP port)");

  aedes.on("client", (client) => {
    console.log(`MQTT client connected: ${client.id}`);
  });

  aedes.on("clientDisconnect", (client) => {
    console.log(`MQTT client disconnected: ${client.id}`);
  });

  return aedes;
}

export function publishToTopic(topic: string, payload: object) {
  const aedes = getAedes();
  aedes.publish(
    {
      topic,
      payload: Buffer.from(JSON.stringify(payload)),
      qos: 1,
      retain: false,
      cmd: "publish",
      dup: false,
    },
    (err) => {
      if (err) console.error(`MQTT publish error on ${topic}:`, err);
    }
  );
}

export function publishNotification(
  influencerId: string,
  type: "notify" | "content",
  payload: object
) {
  publishToTopic(`fp/${influencerId}/${type}`, payload);
}

export function publishDeviceCommand(deviceId: string, command: object) {
  publishToTopic(`fp/device/${deviceId}/command`, command);
}
