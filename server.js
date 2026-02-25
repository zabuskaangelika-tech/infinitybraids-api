require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

// ====== KONFIG ======
const PORT = process.env.PORT || 3000;
const TOP_N = Number(process.env.TOP_N || 5);
const NODE_ENV = process.env.NODE_ENV || "development";

// CORS allowlista (polecam ustawić w Render):
// CORS_ORIGINS=https://silver-lolly-a46eeb.netlify.app,http://localhost:5173
const CORS_ORIGINS = (process.env.CORS_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const DEBUG_ERRORS = String(process.env.DEBUG_ERRORS || "").toLowerCase() === "true";
const OPENAI_TIMEOUT_MS = Number(process.env.OPENAI_TIMEOUT_MS || 20000);

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

// ====== JĘZYK KLIENTA ======
function detectLangFromText(text) {
  const t = (text || "").trim();
  if (!t) return "en";

  const plHints = /[ąćęłńóśźż]/i;
  const plWords = /\b(cześć|czesc|dzień dobry|dzien dobry|poproszę|prosze|dziękuję|dziekuje|kolor|włosy|wlosy|dobierz|dopasuj)\b/i;

  const esWords = /\b(hola|gracias|por favor|cabello|pelo|ayuda)\b/i;
  const frWords = /\b(bonjour|merci|s'il vous plaît|couleur|cheveux)\b/i;
  const deWords = /\b(hallo|danke|bitte|farbe|haare)\b/i;

  if (plHints.test(t) || plWords.test(t)) return "pl";
  if (esWords.test(t)) return "es";
  if (frWords.test(t)) return "fr";
  if (deWords.test(t)) return "de";
  return "en";
}

function toneLabel(tone, lang) {
  const labels = {
    en: { black:"black", dark_brown:"dark brown", medium_brown:"medium brown", light_brown:"light brown", blonde:"blonde", auburn:"auburn", red:"red", grey:"grey", unknown:"unknown" },
    pl: { black:"czarny", dark_brown:"ciemny brąz", medium_brown:"średni brąz", light_brown:"jasny brąz", blonde:"blond", auburn:"kasztan / auburn", red:"rudy", grey:"siwy / szary", unknown:"nieokreślony" },
    es: { black:"negro", dark_brown:"castaño oscuro", medium_brown:"castaño medio", light_brown:"castaño claro", blonde:"rubio", auburn:"castaño rojizo", red:"pelirrojo", grey:"canoso / gris", unknown:"desconocido" },
    fr: { black:"noir", dark_brown:"brun foncé", medium_brown:"brun moyen", light_brown:"brun clair", blonde:"blond", auburn:"auburn", red:"roux", grey:"gris", unknown:"inconnu" },
    de: { black:"schwarz", dark_brown:"dunkelbraun", medium_brown:"mittelbraun", light_brown:"hellbraun", blonde:"blond", auburn:"auburn", red:"rot", grey:"grau", unknown:"unbekannt" },
  };
  const pack = labels[lang] || labels.en;
  return pack[tone] || pack.unknown;
}

function buildHumanMessage({ lang, tone, hair_hex, recommendations }) {
  const top3 = (recommendations || []).slice(0, 3);
  const tLabel = toneLabel(tone, lang);

  const copy = {
    en: {
      greet: "Hello! 😊 Thanks for sending your photo — I’ve got you.",
      intro: `From what I can see, your hair tone looks like **${tLabel}** (approx. ${hair_hex}).`,
      listTitle: "Here are the closest matches from Infinity Braids:",
      tip: "Tip: daylight + no filter gives the most accurate match.",
      close: "If you want, tell me if you prefer a slightly warmer or cooler shade — I’ll fine-tune the picks 💛",
      none: "I can’t confidently match this photo. Could you try another one in natural daylight (no filter), with hair filling most of the frame?",
    },
    pl: {
      greet: "Hej! 😊 Dzięki za zdjęcie — już się tym zajmuję.",
      intro: `Na oko widzę odcień: **${tLabel}** (około ${hair_hex}).`,
      listTitle: "Najbliższe dopasowania z Infinity Braids:",
      tip: "Tip: zdjęcie w dziennym świetle i bez filtra daje najlepsze dopasowanie.",
      close: "Jeśli chcesz — napisz, czy wolisz cieplejszy czy chłodniejszy odcień, a dopasuję jeszcze lepiej 💛",
      none: "Nie umiem tego pewnie dopasować. Podeślij proszę zdjęcie w naturalnym świetle (bez filtra), tak żeby włosy zajmowały większość kadru.",
    },
    es: {
      greet: "¡Hola! 😊 Gracias por la foto — te ayudo con esto.",
      intro: `Por lo que veo, tu tono se parece a **${tLabel}** (aprox. ${hair_hex}).`,
      listTitle: "Las coincidencias más cercanas en Infinity Braids:",
      tip: "Tip: luz natural y sin filtro = mejor precisión.",
      close: "Si quieres, dime si prefieres un tono más cálido o más frío y lo ajusto 💛",
      none: "No puedo igualarlo con seguridad. ¿Puedes enviar otra foto con luz natural (sin filtro) y con el cabello ocupando la mayor parte de la imagen?",
    },
    fr: {
      greet: "Bonjour ! 😊 Merci pour la photo — je m’en occupe.",
      intro: `D’après ce que je vois, ta teinte ressemble à **${tLabel}** (env. ${hair_hex}).`,
      listTitle: "Les meilleures correspondances Infinity Braids :",
      tip: "Astuce : lumière naturelle + sans filtre = meilleur résultat.",
      close: "Si tu veux, dis-moi si tu préfères une teinte plus chaude ou plus froide — j’ajuste 💛",
      none: "Je ne peux pas faire une correspondance fiable. Essaie une autre photo en lumière naturelle (sans filtre), avec les cheveux bien visibles.",
    },
    de: {
      greet: "Hallo! 😊 Danke für das Foto — ich helfe dir gern.",
      intro: `So wie es aussieht, ist dein Haorton **${tLabel}** (ca. ${hair_hex}).`,
      listTitle: "Die besten Matches von Infinity Braids:",
      tip: "Tipp: Tageslicht + kein Filter = genauester Match.",
      close: "Wenn du willst: sag mir, ob du lieber wärmer oder kühler möchtest — ich passe die Auswahl an 💛",
      none: "Ich kann das nicht sicher zuordnen. Bitte versuche ein weiteres Foto bei Tageslicht (ohne Filter), mit Haaren groß im Bild.",
    },
  };

  const c = copy[lang] || copy.en;

  if (!top3.length) {
    return `${c.greet}\n\n${c.intro}\n\n${c.none}`;
  }

  const lines = top3.map((m, i) => `${i + 1}) ${m.name} — ${m.url}`);

  return [
    c.greet,
    "",
    c.intro,
    "",
    c.listTitle,
    ...lines,
    "",
    c.tip,
    c.close,
  ].join("\n");
}

// ====== AI (NIE ZMIENIAM ROZMOWY/PROMPTÓW) ======
async function analyzeHairWithAI(image_data_url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OPENAI_TIMEOUT_MS);

  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        response_format: { type: "json_object" },
        messages: [
          {
            role: "system",
            content:
              "You analyze HAIR COLOR from an image. Return ONLY JSON: " +
              "{\"tone\":\"black|dark_brown|medium_brown|light_brown|blonde|auburn|red|grey\"," +
              "\"hair_hex\":\"#RRGGBB\"}. " +
              "hair_hex must be the dominant hair color (not background, not skin).",
          },
          {
            role: "user",
            content: [
              { type: "text", text: "Analyze the hair in the image and return ONLY the JSON." },
              { type: "image_url", image_url: { url: image_data_url } },
            ],
          },
        ],
        max_tokens: 120,
      }),
    });

    const data = await resp.json().catch(() => null);

    if (!resp.ok) {
      const err = new Error("OpenAI error");
      err.status = resp.status;
      err.details = data;
      throw err;
    }

    const text = data?.choices?.[0]?.message?.content || "{}";
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  } finally {
    clearTimeout(timer);
  }
}

// ====== MATCHING ======
function deltaEToPercent(deltaE) {
  const percent = Math.round(100 - (deltaE * 1.0));
  return Math.max(35, Math.min(99, percent));
}

function matchCatalogByHairHex(hairHex) {
  const hairLab = hexToLab(hairHex);
  if (!hairLab) return [];

  return CATALOG
    .map((p) => {
      let lab = p.lab;
      if (!lab && p.hex) lab = hexToLab(p.hex);
      if (!lab) return null;

      const de = deltaE76(hairLab, lab);
      const match_percent = deltaEToPercent(de);

      return {
        sku: p.sku,
        name: p.name,
        url: p.url,
        deltaE: Number(de.toFixed(2)),
        match_percent,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.deltaE - b.deltaE)
    .slice(0, TOP_N);
}

// ====== IMAGE INPUT: base64 / dataUrl / image_url ======
function toDataUrlMaybe(val) {
  if (typeof val !== "string") return null;
  const v = val.trim();
  if (!v) return null;
  if (v.startsWith("data:image/")) return v;

  // “goły” base64
  if (/^[A-Za-z0-9+/=\s]+$/.test(v.slice(0, 200)) && v.length > 200) {
    return `data:image/jpeg;base64,${v.replace(/\s/g, "")}`;
  }

  return null;
}

async function fetchImageUrlToDataUrl(imageUrl) {
  const resp = await fetch(imageUrl);
  if (!resp.ok) throw new Error(`Failed to fetch image_url: ${resp.status}`);

  const contentType = resp.headers.get("content-type") || "image/jpeg";
  const ab = await resp.arrayBuffer();
  const base64 = Buffer.from(ab).toString("base64");
  return `data:${contentType};base64,${base64}`;
}

async function extractImageDataUrl(body) {
  // szybka ścieżka (różne nazwy pól)
  const directCandidates = [
    body?.image_base64,
    body?.imageBase64,
    body?.image,
    body?.photo,
    body?.file,
    body?.dataUrl,
    body?.data_url,
    body?.imageDataUrl,
    body?.image_data_url,
    body?.payload?.image_base64,
    body?.payload?.image,
    body?.payload?.file,
  ];

  for (const c of directCandidates) {
    const d = toDataUrlMaybe(c);
    if (d) return d;
  }

  // to jest KLUCZ dla Twojego Netlify UI:
  const imageUrl = body?.image_url;
  if (typeof imageUrl === "string" && imageUrl.startsWith("http")) {
    return await fetchImageUrlToDataUrl(imageUrl);
  }

  return null;
}

// ====== APP ======
const app = express();
app.use(helmet());

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // curl/healthchecks
    if (!CORS_ORIGINS.length) {
      // w dev pozwól, w prod lepiej ustawić allowlistę w ENV
      return cb(null, true);
    }
    return cb(CORS_ORIGINS.includes(origin) ? null : new Error("CORS blocked"), CORS_ORIGINS.includes(origin));
  }
}));

app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RATE_LIMIT_PER_MIN || 180),
  standardHeaders: true,
  legacyHeaders: false,
});

const heavyLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.ANALYZE_LIMIT_PER_MIN || 30),
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(globalLimiter);

app.get("/", (req, res) => res.status(200).send("OK - infinitybraids-api is running"));

app.get("/health", (req, res) => {
  const payload = { status: "ok" };
  if (NODE_ENV !== "production") {
    payload.catalogLoaded = CATALOG.length;
    payload.topN = TOP_N;
    payload.hasKey = !!process.env.OPENAI_API_KEY;
  }
  res.json(payload);
});

app.get("/version", (req, res) => {
  res.json({ version: "v3-full-ai-webhook", time: new Date().toISOString() });
});

// ====== POST /analyze (dev / test) ======
app.post("/analyze", heavyLimiter, async (req, res) => {
  try {
    const body = req.body || {};
    const image = await extractImageDataUrl(body);
    const client_text = body?.client_text || body?.text || body?.message || "";

    if (!image) {
      return res.status(400).json({
        ok: false,
        error: "Brak obrazu w body (image_base64/image/photo/... lub image_url)",
        received_keys: Object.keys(body || {}),
      });
    }

    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "Brak OPENAI_API_KEY" });
    if (!CATALOG.length) return res.status(500).json({ ok: false, error: "Brak katalogu (catalog.json obok server.js)" });

    const lang = detectLangFromText(client_text);

    const ai = await analyzeHairWithAI(image);
    const tone = ai?.tone || null;
    const hair_hex = ai?.hair_hex || ai?.hairHex || null;

    const recommendations = hair_hex ? matchCatalogByHairHex(hair_hex) : [];
    const message = buildHumanMessage({
      lang,
      tone,
      hair_hex: hair_hex || "(unknown)",
      recommendations,
    });

    res.json({
      ok: true,
      lang,
      tone,
      hair_hex: hair_hex || null,
      message,
      recommendations,
      ai_raw: DEBUG_ERRORS ? ai : undefined,
    });
  } catch (e) {
    console.error("ANALYZE ERROR:", e);
    res.status(500).json({
      ok: false,
      error: "Server error",
      details: DEBUG_ERRORS ? String(e?.message || e) : undefined,
      openai_details: DEBUG_ERRORS ? e?.details : undefined,
    });
  }
});

// ====== POST /webhook (Netlify UI) ======
app.post("/webhook", heavyLimiter, async (req, res) => {
  try {
    const body = req.body || {};

    const image = await extractImageDataUrl(body);
    const client_text = body?.client_text || body?.text || body?.message || "";

    if (!image) {
      return res.status(400).json({
        ok: false,
        error: "No image found in request. Expected image_base64/image/photo/file/dataUrl OR image_url",
        received_keys: Object.keys(body || {}),
        content_type: req.headers["content-type"] || null,
      });
    }

    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY" });
    if (!CATALOG.length) return res.status(500).json({ ok: false, error: "Catalog not loaded (catalog.json missing)" });

    const lang = detectLangFromText(client_text);

    const ai = await analyzeHairWithAI(image);
    const tone = ai?.tone || null;
    const hair_hex = ai?.hair_hex || ai?.hairHex || null;

    const recommendations = hair_hex ? matchCatalogByHairHex(hair_hex) : [];

    const message = buildHumanMessage({
      lang,
      tone,
      hair_hex: hair_hex || "(unknown)",
      recommendations,
    });

    const top_matches = recommendations.slice(0, 3).map((r, i) => ({
      rank: i + 1,
      title: r.name,
      match: r.match_percent,
      url: r.url,
      sku: r.sku,
    }));

    return res.json({
      ok: true,
      lang,
      tone,
      hair_hex: hair_hex || null,
      message,
      top_matches,
      recommendations,
      ai_raw: DEBUG_ERRORS ? ai : undefined,
    });
  } catch (e) {
    console.error("WEBHOOK ERROR:", e);
    return res.status(500).json({
      ok: false,
      error: "Server error",
      details: DEBUG_ERRORS ? String(e?.message || e) : undefined,
      openai_details: DEBUG_ERRORS ? e?.details : undefined,
    });
  }
});

app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
});