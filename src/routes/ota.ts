import { Hono } from "hono";

const ota = new Hono();

// Firmware registry — in production this would be backed by DB/S3
const firmwareVersions: Record<
  string,
  { version: string; url: string; sha256: string; size: number }
> = {
  "v1": {
    version: "1.0.0",
    url: "https://fw.blink.dev/v1/1.0.0.bin",
    sha256: "placeholder",
    size: 0,
  },
};

ota.get("/:hardware_version/latest", async (c) => {
  const hwVersion = c.req.param("hardware_version");
  const fw = firmwareVersions[hwVersion];

  if (!fw) {
    return c.json({ error: "No firmware available for this hardware version" }, 404);
  }

  return c.json({
    hardware_version: hwVersion,
    firmware_version: fw.version,
    download_url: fw.url,
    sha256: fw.sha256,
    size: fw.size,
  });
});

export default ota;
