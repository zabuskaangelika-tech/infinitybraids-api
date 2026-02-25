require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// ====== KONFIG ======
const PORT = process.env.PORT || 3000;
const TOP_N = Number(process.env.TOP_N || 5);

// ====== FETCH ======
let fetchFn = global.fetch;
async function getFetch() {
  if (fetchFn) return fetchFn;
  const mod = await import("node-fetch");
  fetchFn = mod.default;
  return fetchFn;
}

// ====== WCZYTAJ KATALOG ======
let CATALOG_RAW;
try {
  CATALOG_RAW = require("./catalog.json");
} catch (e) {
  CATALOG_RAW = null;
}

function normalizeCatalog(raw) {
  const arr =
    Array.isArray(raw) ? raw :
    Array.isArray(raw?.products) ? raw.products :
    Array.isArray(raw?.items) ? raw.items :
    null;

  if (!arr) return [];

  return arr
    .map((p, idx) => {
      const sku = p.sku || p.SKU || p.id || p.ID || `item_${idx}`;
      const name = p.name || p.title || p.product_name || p.ProductName || String(sku);
      const url = p.url || p.link || p.product_url || p.ProductURL || "";

      let lab = p.lab || p.Lab || p.LAB || null;
      if (lab && !Array.isArray(lab) && typeof lab === "object") {
        const L = lab.L ?? lab.l;
        const a = lab.a ?? lab.A;
        const b = lab.b ?? lab.B;
        if ([L, a, b].every((x) => typeof x === "number")) lab = [L, a, b];
        else lab = null;
      }
      if (!(Array.isArray(lab) && lab.length === 3 && lab.every((x) => typeof x === "number"))) {
        lab = null;
      }

      const hex = p.hex || p.Hex || p.color_hex || p.ColorHex || null;
      const type = (p.type || p.product_type || p.category || "").toString();

      return { raw: p, sku, name, url, lab, hex, type };
    })
    .filter(Boolean);
}

const CATALOG = normalizeCatalog(CATALOG_RAW);

// ====== KONWERSJE KOLORU ======
function hexToRgb(hex) {
  if (typeof hex !== "string") return null;
  let h = hex.trim().replace("#", "");
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (h.length !== 6) return null;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  if ([r, g, b].some((v) => Number.isNaN(v))) return null;
  return { r, g, b };
}

function rgbToXyz({ r, g, b }) {
  let R = r / 255, G = g / 255, B = b / 255;

  R = R > 0.04045 ? Math.pow((R + 0.055) / 1.055, 2.4) : R / 12.92;
  G = G > 0.04045 ? Math.pow((G + 0.055) / 1.055, 2.4) : G / 12.92;
  B = B > 0.04045 ? Math.pow((B + 0.055) / 1.055, 2.4) : B / 12.92;

  const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) * 100;
  const Y = (R * 0.2126 + G * 0.7152 + B * 0.0722) * 100;
  const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) * 100;

  return { X, Y, Z };
}

function xyzToLab({ X, Y, Z }) {
  const refX = 95.047;
  const refY = 100.0;
  const refZ = 108.883;

  let x = X / refX;
  let y = Y / refY;
  let z = Z / refZ;

  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : (7.787 * t) + (16 / 116));

  x = f(x);
  y = f(y);
  z = f(z);

  const L = (116 * y) - 16;
  const a = 500 * (x - y);
  const b = 200 * (y - z);

  return [L, a, b];
}

function deltaE76(lab1, lab2) {
  const dL = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

function hexToLab(hex) {
  const rgb = hexToRgb(hex);
  if (!rgb) return null;
  const xyz = rgbToXyz(rgb);
  return xyzToLab(xyz);
}

// ====== WYCIĄGANIE OBRAZU (base64 LUB image_url) ======
async function extractImageDataUrl(body) {
  const direct = [
    body?.image_base64,
    body?.image,
    body?.photo,
    body?.file,
    body?.dataUrl,
    body?.data_url,
    body?.imageDataUrl,
    body?.image_data_url,
  ].find((x) => typeof x === "string" && x.length > 20);

  if (direct) {
    if (direct.startsWith("data:image/")) return direct;
    return `data:image/jpeg;base64,${direct}`;
  }

  const url = body?.image_url;
  if (typeof url === "string" && url.startsWith("http")) {
    const fetch = await getFetch();
    const resp = await fetch(url);
    const buf = Buffer.from(await resp.arrayBuffer());
    const base64 = buf.toString("base64");
    const contentType = resp.headers.get("content-type") || "image/jpeg";
    return `data:${contentType};base64,${base64}`;
  }

  return null;
}

// ====== SERWER ======
const app = express();
app.use(cors());
app.use(helmet());
app.use(express.json({ limit: "25mb" }));

const heavyLimiter = rateLimit({ windowMs: 60 * 1000, max: 30 });

app.get("/", (req, res) => res.send("OK - infinitybraids-api is running"));
app.get("/health", (req, res) => res.json({ status: "ok" }));

app.post("/webhook", heavyLimiter, async (req, res) => {
  try {
    const image = await extractImageDataUrl(req.body || {});
    if (!image) {
      return res.status(400).json({
        ok: false,
        error: "No image found in request. Expected image_base64/image/photo/file/dataUrl/image_url",
        received_keys: Object.keys(req.body || {}),
      });
    }

    return res.json({
      ok: true,
      message: "Image received correctly and ready for AI analysis 🎉"
    });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    return res.status(500).json({ ok: false, error: "Server error", details: String(e) });
  }
});
app.get("/version", (req, res) => {
  res.json({
    version: "v2-image-url",
    time: new Date().toISOString()
  });
});
app.listen(PORT, () => console.log(`API listening on port ${PORT}`));