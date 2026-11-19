const CANON_SUMMARY = {
  version: "17.1.0",
  name: "Divination Tarot Sanctuary",
  deck: "78-Card Rider-Waite-Smith Living Deck",
  suits: {
    majorArcana: 22,
    wands: 14,
    cups: 14,
    swords: 14,
    pentacles: 14
  },
  totalCards: 78,
  modules: [
    "Tactile Reading Table",
    "Aura AI Live Teleprompter",
    "Arcane Forge",
    "Seeker CRM",
    "Creator Marketplace",
    "Divination Academy"
  ]
};

const LEGAL_POLICIES = {
  service: "Divination Tarot v17.1.0 Sanctuary",
  effectiveDate: "2026-11-19",
  policies: [
    {
      id: "entertainment-disclaimer",
      title: "Spiritual & Entertainment Guidance",
      summary: "Tarot readings, Aura AI teleprompter prompts, and academy lessons are offered for reflection, creative insight, and personal growth, not medical, legal, or financial advice."
    },
    {
      id: "privacy-data",
      title: "Seeker Privacy & Local-First Sanctuary",
      summary: "Seeker CRM notes and spread logs remain private to the practitioner workspace with strict CSP and HSTS preload transport security."
    },
    {
      id: "payments-guard",
      title: "Marketplace & Checkout Guardrail",
      summary: "Live payments are governed by LIVE_PAYMENTS_APPROVED configuration; when false, Creator Marketplace operates in safe preview mode."
    }
  ]
};

function buildTeleprompterPayload(input = {}) {
  const question = (input.question || "What energy is emerging in my path today?").trim();
  const spread = input.spread || "Three-Card Past / Present / Future";
  const cards = Array.isArray(input.cards) ? input.cards : [];
  const cardNames = cards.map((c) => (typeof c === "string" ? c : `${c.name}${c.reversed ? " (Reversed)" : ""}`)).filter(Boolean);
  const focus = cardNames.length ? cardNames.join(", ") : "The Fool, The High Priestess, The Star";

  return {
    engine: "Aura AI Live Teleprompter v17.1.0",
    spread,
    question,
    activeCards: cardNames,
    liveScript: `Open the space gently around "${question}". Anchor the seeker in ${focus}, inviting them to notice where intuition and practical action meet before naming the next threshold.`,
    predictiveFollowUps: [
      `How does the shift signaled by ${cardNames[0] || "the opening card"} show up in your daily routine this week?`,
      `What boundary or resource would help you honor the lesson of ${cardNames[1] || "the center card"}?`,
      `If you act on this reading within 48 hours, what single concrete step feels most aligned?`,
      `Which recurring pattern from the past are you ready to release as this cycle turns?`
    ],
    timestamp: new Date().toISOString()
  };
}

function sendJson(res, statusCode, payload) {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload, null, 2));
}

function readJsonBody(req) {
  return new Promise((resolve) => {
    if (req.body && typeof req.body === "object") {
      return resolve(req.body);
    }
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

async function handler(req, res) {
  const url = new URL(req.url || "/", `https://${req.headers.host || "divinationtarot.app"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  if (path === "/api/health") {
    return sendJson(res, 200, {
      status: "ok",
      service: "divination-tarot",
      version: "17.1.0",
      timestamp: new Date().toISOString()
    });
  }

  if (path === "/api/readyz") {
    return sendJson(res, 200, {
      ready: true,
      service: "divination-tarot",
      version: "17.1.0",
      environment: {
        NODE_ENV: process.env.NODE_ENV || "production",
        PRODUCTION_SAFE_SEED: process.env.PRODUCTION_SAFE_SEED || "true",
        LIVE_PAYMENTS_APPROVED: process.env.LIVE_PAYMENTS_APPROVED || "false",
        PUBLIC_BASE_URL: process.env.PUBLIC_BASE_URL || "https://divinationtarot.app"
      },
      endpoints: [
        "/api/health",
        "/api/readyz",
        "/api/canon",
        "/api/legal/policies",
        "/api/aura/teleprompter"
      ],
      timestamp: new Date().toISOString()
    });
  }

  if (path === "/api/canon") {
    return sendJson(res, 200, CANON_SUMMARY);
  }

  if (path === "/api/legal/policies") {
    return sendJson(res, 200, LEGAL_POLICIES);
  }

  if (path === "/api/aura/teleprompter") {
    const body = req.method === "POST" ? await readJsonBody(req) : {
      question: url.searchParams.get("question") || undefined,
      spread: url.searchParams.get("spread") || undefined
    };
    return sendJson(res, 200, buildTeleprompterPayload(body));
  }

  return sendJson(res, 404, { error: "Not Found", path });
}

module.exports = handler;

if (require.main === module) {
  const http = require("http");
  const port = Number(process.env.PORT || 3000);
  http.createServer((req, res) => handler(req, res)).listen(port, () => {
    console.log(`Divination Tarot API listening on port ${port}`);
  });
}
