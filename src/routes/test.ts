import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { db } from "../lib/db";
import { devices, influencers, notifications, notificationDeliveries } from "../lib/db/schema";
import { publishNotification } from "../lib/mqtt";
import { eq } from "drizzle-orm";

const test = new Hono();

// ── Test Pulse (no auth — for manufacturer testing) ──────────────────
const testPulseSchema = z.object({
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default("#FF0000"),
  pattern: z.enum(["solid", "pulse", "flash", "rainbow"]).default("solid"),
  duration_ms: z.number().int().min(100).max(30000).default(3000),
  brightness: z.number().int().min(0).max(100).default(100),
});

// POST /api/v1/test/pulse — trigger blink on all devices (no auth)
test.post("/pulse", zValidator("json", testPulseSchema), async (c) => {
  const payload = c.req.valid("json");

  // Find all influencers and their devices
  const allInfluencers = await db.select().from(influencers);

  if (allInfluencers.length === 0) {
    return c.json({ error: "No influencers registered. Register one first via /api/v1/auth/register" }, 404);
  }

  let totalDevices = 0;

  for (const inf of allInfluencers) {
    const deviceList = await db
      .select()
      .from(devices)
      .where(eq(devices.influencerId, inf.id));

    totalDevices += deviceList.length;

    // Save notification to DB
    const [notification] = await db
      .insert(notifications)
      .values({
        influencerId: inf.id,
        type: "pulse",
        payload,
      })
      .returning();

    if (deviceList.length > 0) {
      await db.insert(notificationDeliveries).values(
        deviceList.map((d) => ({
          notificationId: notification.id,
          deviceId: d.id,
        }))
      );
    }

    // Publish to MQTT — both topic formats for compatibility
    const mqttPayload = {
      notification_id: notification.id,
      type: "blink",
      color: payload.color,
      pattern: payload.pattern,
      duration_ms: payload.duration_ms,
      brightness: payload.brightness,
    };

    // Original API format: fp/{influencer_id}/notify
    publishNotification(inf.id, "notify", mqttPayload);

    // Manufacturer spec format: blink/{artist_id}/events
    // (import publishToTopic for custom topic)
    const { publishToTopic } = await import("../lib/mqtt");
    publishToTopic(`blink/${inf.id}/events`, mqttPayload);
  }

  return c.json({
    ok: true,
    message: `Blink sent to ${totalDevices} device(s) across ${allInfluencers.length} influencer(s)`,
    devices_reached: totalDevices,
    payload,
  });
});

// POST /api/v1/test/pulse/:influencer_id — trigger blink for specific influencer
test.post("/pulse/:influencer_id", zValidator("json", testPulseSchema), async (c) => {
  const influencerId = c.req.param("influencer_id");
  const payload = c.req.valid("json");

  const [inf] = await db
    .select()
    .from(influencers)
    .where(eq(influencers.id, influencerId))
    .limit(1);

  if (!inf) {
    return c.json({ error: "Influencer not found" }, 404);
  }

  const deviceList = await db
    .select()
    .from(devices)
    .where(eq(devices.influencerId, inf.id));

  const [notification] = await db
    .insert(notifications)
    .values({
      influencerId: inf.id,
      type: "pulse",
      payload,
    })
    .returning();

  if (deviceList.length > 0) {
    await db.insert(notificationDeliveries).values(
      deviceList.map((d) => ({
        notificationId: notification.id,
        deviceId: d.id,
      }))
    );
  }

  const mqttPayload = {
    notification_id: notification.id,
    type: "blink",
    color: payload.color,
    pattern: payload.pattern,
    duration_ms: payload.duration_ms,
    brightness: payload.brightness,
  };

  publishNotification(inf.id, "notify", mqttPayload);

  const { publishToTopic } = await import("../lib/mqtt");
  publishToTopic(`blink/${inf.id}/events`, mqttPayload);

  return c.json({
    ok: true,
    message: `Blink sent to ${deviceList.length} device(s)`,
    devices_reached: deviceList.length,
    payload,
  });
});

// GET /api/v1/test/status — list all influencers and devices (for debugging)
test.get("/status", async (c) => {
  const allInfluencers = await db.select({
    id: influencers.id,
    name: influencers.name,
    slug: influencers.slug,
    brandColor: influencers.brandColor,
  }).from(influencers);

  const allDevices = await db.select({
    id: devices.id,
    deviceId: devices.deviceId,
    influencerId: devices.influencerId,
    mode: devices.mode,
    batteryPercent: devices.batteryPercent,
    lastSeen: devices.lastSeen,
    firmwareVersion: devices.firmwareVersion,
  }).from(devices);

  return c.json({
    influencers: allInfluencers,
    devices: allDevices,
    summary: {
      total_influencers: allInfluencers.length,
      total_devices: allDevices.length,
    },
  });
});

// GET /api/v1/test — serve the test UI HTML page
test.get("/", async (c) => {
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Blink — LED Test Tool / LED 测试工具</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0a0a0a; color: #fff; min-height: 100vh; padding: 20px; }
  .container { max-width: 600px; margin: 0 auto; }
  h1 { font-size: 28px; margin-bottom: 4px; }
  .subtitle { color: #888; margin-bottom: 30px; font-size: 14px; }
  .card { background: #1a1a1a; border-radius: 12px; padding: 24px; margin-bottom: 16px; border: 1px solid #333; }
  .card h2 { font-size: 18px; margin-bottom: 16px; }
  label { display: block; font-size: 13px; color: #aaa; margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.5px; }
  .color-row { display: flex; gap: 12px; align-items: center; margin-bottom: 16px; }
  .color-input { width: 60px; height: 40px; border: none; border-radius: 8px; cursor: pointer; background: none; }
  .color-hex { background: #222; border: 1px solid #444; color: #fff; padding: 8px 12px; border-radius: 8px; font-size: 16px; width: 120px; font-family: monospace; }
  .presets { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  .preset { width: 36px; height: 36px; border-radius: 50%; border: 2px solid transparent; cursor: pointer; transition: all 0.2s; }
  .preset:hover, .preset.active { border-color: #fff; transform: scale(1.15); }
  select, input[type=range] { width: 100%; background: #222; border: 1px solid #444; color: #fff; padding: 10px; border-radius: 8px; font-size: 15px; margin-bottom: 16px; }
  input[type=range] { padding: 0; height: 6px; -webkit-appearance: none; appearance: none; border: none; }
  input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; border-radius: 50%; background: #fff; cursor: pointer; }
  .range-row { margin-bottom: 16px; }
  .range-labels { display: flex; justify-content: space-between; font-size: 12px; color: #666; margin-top: 4px; }
  .range-value { color: #fff; font-weight: 600; }
  .btn { width: 100%; padding: 16px; border: none; border-radius: 12px; font-size: 18px; font-weight: 700; cursor: pointer; transition: all 0.2s; text-transform: uppercase; letter-spacing: 1px; }
  .btn-blink { background: linear-gradient(135deg, #FF0000, #FF6600); color: #fff; }
  .btn-blink:hover { transform: translateY(-2px); box-shadow: 0 8px 30px rgba(255,0,0,0.3); }
  .btn-blink:active { transform: translateY(0); }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; }
  .status { margin-top: 16px; padding: 12px; border-radius: 8px; font-size: 14px; display: none; }
  .status.success { display: block; background: #1a3a1a; border: 1px solid #2d5a2d; color: #6fbf6f; }
  .status.error { display: block; background: #3a1a1a; border: 1px solid #5a2d2d; color: #bf6f6f; }
  .status.loading { display: block; background: #1a1a3a; border: 1px solid #2d2d5a; color: #6f6fbf; }
  .info { background: #111; border-radius: 8px; padding: 16px; margin-top: 20px; font-size: 13px; color: #888; line-height: 1.6; }
  .info code { background: #222; padding: 2px 6px; border-radius: 4px; color: #aaa; font-size: 12px; }
  .preview { width: 80px; height: 80px; border-radius: 50%; margin: 0 auto 16px; transition: all 0.3s; box-shadow: 0 0 30px rgba(255,0,0,0.4); }
  .lang-toggle { text-align: right; margin-bottom: 16px; }
  .lang-toggle button { background: #222; border: 1px solid #444; color: #aaa; padding: 6px 12px; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .lang-toggle button:hover { color: #fff; border-color: #666; }
  .device-list { margin-top: 12px; }
  .device-item { background: #222; border-radius: 8px; padding: 10px 14px; margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; }
  .device-id { font-family: monospace; color: #aaa; }
  .device-status { font-size: 12px; padding: 3px 8px; border-radius: 4px; }
  .device-status.online { background: #1a3a1a; color: #6fbf6f; }
  .device-status.offline { background: #3a1a1a; color: #bf6f6f; }
</style>
</head>
<body>
<div class="container">
  <div class="lang-toggle">
    <button onclick="toggleLang()" id="langBtn">中文</button>
  </div>

  <h1>💡 Blink <span data-en="Test Tool" data-zh="测试工具" class="t">Test Tool</span></h1>
  <p class="subtitle" data-en="Control the LED on connected Blink devices" data-zh="控制已连接 Blink 设备的 LED 灯">Control the LED on connected Blink devices</p>

  <!-- Device Status -->
  <div class="card">
    <h2 data-en="📡 Connected Devices" data-zh="📡 已连接设备" class="t">📡 Connected Devices</h2>
    <div id="deviceStatus"><span data-en="Loading..." data-zh="加载中..." class="t">Loading...</span></div>
  </div>

  <!-- LED Preview -->
  <div class="card" style="text-align:center;">
    <div class="preview" id="preview"></div>
    <p style="font-size:13px;color:#888;" data-en="Preview" data-zh="预览" class="t">Preview</p>
  </div>

  <!-- Color -->
  <div class="card">
    <h2 data-en="🎨 Color / 颜色" data-zh="🎨 颜色" class="t">🎨 Color</h2>
    <div class="color-row">
      <input type="color" id="colorPicker" value="#FF0000" class="color-input" onchange="syncColor(this.value)">
      <input type="text" id="colorHex" value="#FF0000" class="color-hex" onchange="syncColor(this.value)">
    </div>
    <label data-en="Preset Colors" data-zh="预设颜色" class="t">Preset Colors</label>
    <div class="presets">
      <div class="preset" style="background:#FF0000" onclick="syncColor('#FF0000')"></div>
      <div class="preset" style="background:#FF6600" onclick="syncColor('#FF6600')"></div>
      <div class="preset" style="background:#FFFF00" onclick="syncColor('#FFFF00')"></div>
      <div class="preset" style="background:#00FF00" onclick="syncColor('#00FF00')"></div>
      <div class="preset" style="background:#00FFFF" onclick="syncColor('#00FFFF')"></div>
      <div class="preset" style="background:#0066FF" onclick="syncColor('#0066FF')"></div>
      <div class="preset" style="background:#9900FF" onclick="syncColor('#9900FF')"></div>
      <div class="preset" style="background:#FF00FF" onclick="syncColor('#FF00FF')"></div>
      <div class="preset" style="background:#FFFFFF" onclick="syncColor('#FFFFFF')"></div>
    </div>
  </div>

  <!-- Pattern -->
  <div class="card">
    <h2 data-en="✨ Pattern / 模式" data-zh="✨ 灯光模式" class="t">✨ Pattern</h2>
    <select id="pattern">
      <option value="solid" data-en="Solid — steady light" data-zh="常亮 — 持续亮灯">Solid — steady light</option>
      <option value="pulse" data-en="Pulse — fade in/out" data-zh="呼吸灯 — 渐亮渐暗">Pulse — fade in/out</option>
      <option value="flash" data-en="Flash — rapid blinking" data-zh="闪烁 — 快速闪烁">Flash — rapid blinking</option>
      <option value="rainbow" data-en="Rainbow — color cycle" data-zh="彩虹 — 颜色循环">Rainbow — color cycle</option>
    </select>
  </div>

  <!-- Duration -->
  <div class="card">
    <h2 data-en="⏱ Duration / 持续时间" data-zh="⏱ 持续时间" class="t">⏱ Duration</h2>
    <div class="range-row">
      <input type="range" id="duration" min="500" max="30000" value="3000" step="500" oninput="updateDurationLabel()">
      <div class="range-labels">
        <span>0.5s</span>
        <span class="range-value" id="durationLabel">3.0s</span>
        <span>30s</span>
      </div>
    </div>
  </div>

  <!-- Brightness -->
  <div class="card">
    <h2 data-en="🔆 Brightness / 亮度" data-zh="🔆 亮度" class="t">🔆 Brightness</h2>
    <div class="range-row">
      <input type="range" id="brightness" min="0" max="100" value="100" oninput="updateBrightnessLabel()">
      <div class="range-labels">
        <span>0%</span>
        <span class="range-value" id="brightnessLabel">100%</span>
        <span>100%</span>
      </div>
    </div>
  </div>

  <!-- Send Button -->
  <button class="btn btn-blink" id="sendBtn" onclick="sendBlink()">
    <span data-en="⚡ SEND BLINK" data-zh="⚡ 发送闪烁指令" class="t">⚡ SEND BLINK</span>
  </button>
  <div class="status" id="status"></div>

  <!-- API Info -->
  <div class="info">
    <strong data-en="API Endpoint (for direct testing):" data-zh="API 接口（直接测试用）：" class="t">API Endpoint (for direct testing):</strong><br>
    <code>POST ${"{BASE_URL}"}/api/v1/test/pulse</code><br><br>
    <span data-en="Example:" data-zh="示例：" class="t">Example:</span><br>
    <code style="white-space:pre;display:block;margin-top:4px;padding:8px;line-height:1.5;">curl -X POST ${"{BASE_URL}"}/api/v1/test/pulse \\
  -H "Content-Type: application/json" \\
  -d '{"color":"#FF0000","pattern":"solid","duration_ms":3000,"brightness":100}'</code>
  </div>
</div>

<script>
let lang = 'en';
const API = window.location.origin;

function toggleLang() {
  lang = lang === 'en' ? 'zh' : 'en';
  document.getElementById('langBtn').textContent = lang === 'en' ? '中文' : 'English';
  document.querySelectorAll('.t,[data-en]').forEach(el => {
    const text = el.getAttribute('data-' + lang);
    if (text) el.textContent = text;
  });
  // Update select options
  document.querySelectorAll('option[data-en]').forEach(el => {
    const text = el.getAttribute('data-' + lang);
    if (text) el.textContent = text;
  });
}

function syncColor(hex) {
  hex = hex.toUpperCase();
  if (!/^#[0-9A-F]{6}$/.test(hex)) return;
  document.getElementById('colorPicker').value = hex;
  document.getElementById('colorHex').value = hex;
  document.getElementById('preview').style.background = hex;
  document.getElementById('preview').style.boxShadow = '0 0 40px ' + hex + '80';
  document.querySelectorAll('.preset').forEach(p => {
    p.classList.toggle('active', p.style.background.toUpperCase() === hex || rgbToHex(p.style.background) === hex);
  });
}

function rgbToHex(rgb) {
  if (rgb.startsWith('#')) return rgb.toUpperCase();
  const m = rgb.match(/\\d+/g);
  if (!m) return '';
  return '#' + m.slice(0,3).map(x => parseInt(x).toString(16).padStart(2,'0')).join('').toUpperCase();
}

function updateDurationLabel() {
  const v = document.getElementById('duration').value;
  document.getElementById('durationLabel').textContent = (v / 1000).toFixed(1) + 's';
}

function updateBrightnessLabel() {
  document.getElementById('brightnessLabel').textContent = document.getElementById('brightness').value + '%';
}

async function loadDevices() {
  try {
    const res = await fetch(API + '/api/v1/test/status');
    const data = await res.json();
    const container = document.getElementById('deviceStatus');
    if (data.summary.total_devices === 0) {
      container.innerHTML = '<span style="color:#bf6f6f;">' + (lang === 'zh' ? '未找到设备。请先注册设备。' : 'No devices found. Register a device first.') + '</span>';
      return;
    }
    let html = '<div style="margin-bottom:8px;color:#aaa;font-size:13px;">' +
      (lang === 'zh' ? '共 ' : '') + data.summary.total_devices + (lang === 'zh' ? ' 台设备' : ' device(s)') +
      ' / ' + data.summary.total_influencers + (lang === 'zh' ? ' 位创作者' : ' influencer(s)') + '</div>';
    html += '<div class="device-list">';
    data.devices.forEach(d => {
      const online = d.lastSeen && (Date.now() - new Date(d.lastSeen).getTime()) < 5 * 60 * 1000;
      html += '<div class="device-item">' +
        '<span class="device-id">' + d.deviceId + '</span>' +
        '<span class="device-status ' + (online ? 'online' : 'offline') + '">' +
        (online ? (lang === 'zh' ? '在线' : 'Online') : (lang === 'zh' ? '离线' : 'Offline')) +
        '</span></div>';
    });
    html += '</div>';
    container.innerHTML = html;
  } catch (e) {
    document.getElementById('deviceStatus').innerHTML = '<span style="color:#bf6f6f;">Error loading devices</span>';
  }
}

async function sendBlink() {
  const btn = document.getElementById('sendBtn');
  const status = document.getElementById('status');
  btn.disabled = true;

  status.className = 'status loading';
  status.textContent = lang === 'zh' ? '发送中...' : 'Sending...';
  status.style.display = 'block';

  try {
    const body = {
      color: document.getElementById('colorHex').value,
      pattern: document.getElementById('pattern').value,
      duration_ms: parseInt(document.getElementById('duration').value),
      brightness: parseInt(document.getElementById('brightness').value),
    };

    const res = await fetch(API + '/api/v1/test/pulse', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const data = await res.json();
    if (data.ok) {
      status.className = 'status success';
      status.textContent = (lang === 'zh' ? '✅ 成功！已发送到 ' : '✅ Success! Sent to ') + data.devices_reached + (lang === 'zh' ? ' 台设备' : ' device(s)');
    } else {
      status.className = 'status error';
      status.textContent = '❌ ' + (data.error || data.message || 'Unknown error');
    }
  } catch (e) {
    status.className = 'status error';
    status.textContent = '❌ ' + (lang === 'zh' ? '网络错误: ' : 'Network error: ') + e.message;
  }

  btn.disabled = false;
  setTimeout(() => { status.style.display = 'none'; }, 5000);
}

// Init
syncColor('#FF0000');
loadDevices();
setInterval(loadDevices, 15000);
</script>
</body>
</html>`;

  return c.html(html);
});

export default test;
