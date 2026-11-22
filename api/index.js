'use strict';
const crypto = require('crypto');
let Pool = null;
try { ({ Pool } = require('pg')); } catch (_) {}

let pool = null;
function getPool() {
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
  if (!url || !Pool) return null;
  if (!pool) {
    pool = new Pool({
      connectionString: url,
      max: Math.min(Number(process.env.PG_POOL_MAX || 1), 3),
      ssl: process.env.PG_SSL_MODE === 'disable' ? false : { rejectUnauthorized: false }
    });
  }
  return pool;
}

const SUITS = [
  { suit: 'Wands', label: 'Wands', elem: 'Fire', p1: '#d97706', p2: '#7c2d12' },
  { suit: 'Cups', label: 'Cups', elem: 'Water', p1: '#38bdf8', p2: '#1e3a8a' },
  { suit: 'Swords', label: 'Swords', elem: 'Air', p1: '#cbd5e1', p2: '#312e81' },
  { suit: 'Pentacles', label: 'Pentacles', elem: 'Earth', p1: '#facc15', p2: '#14532d' }
];
const MAJORS = [
  ['0','The Fool'],['I','The Magician'],['II','The High Priestess'],['III','The Empress'],
  ['IV','The Emperor'],['V','The Hierophant'],['VI','The Lovers'],['VII','The Chariot'],
  ['VIII','Strength'],['IX','The Hermit'],['X','Wheel of Fortune'],['XI','Justice'],
  ['XII','The Hanged Man'],['XIII','Death'],['XIV','Temperance'],['XV','The Devil'],
  ['XVI','The Tower'],['XVII','The Star'],['XVIII','The Moon'],['XIX','The Sun'],
  ['XX','Judgement'],['XXI','The World']
];
const RANKS = ['Ace','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Page','Knight','Queen','King'];
const CANON_78 = [
  ...MAJORS.map(([num, name], idx) => ({ idx, num, name, full: `${num} — ${name}`, arcana: 'Major', suit: 'Major', p1: '#f59e0b', p2: '#312e81' })),
  ...SUITS.flatMap((s, si) => RANKS.map((rk, ri) => {
    const idx = 22 + si * 14 + ri;
    const nm = `${rk} of ${s.label}`;
    return { idx, num: String(ri + 1), name: nm, full: nm, arcana: 'Minor', suit: s.suit, p1: s.p1, p2: s.p2 };
  }))
];

const uid = (p) => `${p}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
const fromB64u = (str) => {
  const n = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(n + (n.length % 4 ? '='.repeat(4 - (n.length % 4)) : ''), 'base64');
};
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const hashPw = (pw) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const dk = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${dk}`;
};
const verifyPw = (pw, stored) => {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const dk = crypto.scryptSync(String(pw), parts[1], 64);
  const exp = Buffer.from(parts[2], 'hex');
  return dk.length === exp.length && crypto.timingSafeEqual(dk, exp);
};
const parseCookies = (hdr) => Object.fromEntries(
  String(hdr || '').split(';').map((p) => p.trim().split('=')).filter((kv) => kv.length >= 2).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
);
const readBody = (req) => new Promise((resolve) => {
  if (req.body && typeof req.body === 'object') return resolve(req.body);
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (_) { resolve({}); } });
});
const send = (res, code, obj) => {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
};

async function getSessionAuth(db, req) {
  const sid = parseCookies(req.headers?.cookie).div_sid;
  if (!sid || !db) return null;
  const th = sha256(sid);
  const { rows } = await db.query(
    `SELECT s.id AS session_id, s.csrf_token, u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > $2 LIMIT 1`,
    [th, new Date().toISOString()]
  );
  return rows[0] || null;
}

async function buildBootstrap(db, userRow, csrfToken) {
  const [dRes, cRes, clRes, rRes] = await Promise.all([
    db.query('SELECT * FROM decks WHERE owner_id = $1 ORDER BY created_at ASC', [userRow.id]),
    db.query('SELECT * FROM card_entities WHERE owner_id = $1 ORDER BY canonical_index ASC', [userRow.id]),
    db.query('SELECT * FROM crm_clients WHERE reader_id = $1 ORDER BY created_at DESC', [userRow.id]).catch(() => ({ rows: [] })),
    db.query('SELECT * FROM readings WHERE reader_id = $1 ORDER BY created_at DESC LIMIT 50', [userRow.id]).catch(() => ({ rows: [] }))
  ]);
  return {
    authenticated: true,
    csrfToken,
    user: {
      id: userRow.id, handle: userRow.handle, displayName: userRow.display_name, email: userRow.email,
      readerTitle: userRow.reader_title || 'Initiate Cartomancer', bio: userRow.bio || '',
      xp: Number(userRow.xp || 0), level: Number(userRow.level || 1),
      shards: Number(userRow.astral_shards || 540), moonwaterVials: Number(userRow.moonwater_vials || 6),
      clothStyle: userRow.cloth_style || 'cloth-midnight-indigo',
      audioEnabled: Boolean(userRow.audio_enabled), hapticsEnabled: Boolean(userRow.haptics_enabled),
      isAdmin: Boolean(userRow.is_admin), blueprintRank: userRow.blueprint_rank || 'novice',
      astralDust: Number(userRow.astral_dust ?? 40)
    },
    decks: dRes.rows.map((d) => ({
      id: d.id, ownerId: d.owner_id, name: d.name, description: d.description || '',
      aestheticStyle: d.aesthetic_style || '', borderMaterial: d.border_material || 'obsidian',
      isActive: Boolean(d.is_active), isShowcased: Boolean(d.is_showcased), isListed: Boolean(d.is_listed)
    })),
    cards: cRes.rows.map((r) => {
      const c = CANON_78[r.canonical_index] || CANON_78[0];
      return {
        id: r.id, ownerId: r.owner_id, deckId: r.deck_id, canonicalIndex: Number(r.canonical_index),
        canonicalName: r.canonical_name, shortName: c.name, numeral: c.num, arcana: r.arcana_type, suit: r.suit,
        vitality: Number(r.vitality ?? 100), structuralIntegrity: Number(r.structural_integrity ?? r.vitality ?? 100),
        surfaceCondition: Number(r.surface_condition ?? 100), edgeCondition: Number(r.edge_condition ?? 100),
        cornerCondition: Number(r.corner_condition ?? 100), destroyed: Boolean(r.is_destroyed),
        karma: Number(r.karma || 0), readingsCount: Number(r.readings_count || 0),
        serialNumber: r.serial_number, customTitle: r.custom_title || c.name,
        palettePrimary: r.palette_primary || c.p1, paletteSecondary: r.palette_secondary || c.p2,
        originalArtworkUrl: r.original_artwork_url || `/assets/cards/deck78_${String(r.canonical_index).padStart(2, '0')}.webp`,
        rarityTier: r.rarity_tier || 'common', isImmortal: Boolean(r.is_immortal)
      };
    }),
    clients: clRes.rows,
    readings: rRes.rows,
    marketplaceListings: []
  };
}

function scrubPii(txt) {
  return String(txt || '')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED_EMAIL]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[REDACTED_PHONE]')
    .slice(0, 600);
}

async function callGeminiFlash(systemInstruction, userPrompt) {
  const keys = [process.env.GEMINI_API_KEY, process.env.GEMINI_API_KEY_FALLBACK]
    .flatMap((v) => String(v || '').split(/[|,]/))
    .map((k) => k.trim())
    .filter(Boolean);
  if (!keys.length) return null;
  const models = Array.from(new Set([process.env.GEMINI_TEXT_MODEL, 'gemini-flash-latest', 'gemini-2.5-flash'].filter(Boolean)));
  for (const apiKey of keys) {
    for (const model of models) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: scrubPii(userPrompt) }] }],
        generationConfig: { temperature: 0.65, maxOutputTokens: 420 }
      }),
      signal: ctrl.signal
    });
    if (!resp.ok) return null;
    const data = await resp.json();
      const txt = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || '').join('').trim();
      if (txt) return txt;
    } catch (_) {
    } finally {
      clearTimeout(t);
    }
    }
  }
  return null;
}

async function sendResendEmail({ to, subject, html, text }) {
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey || !to) return { sent: false, provider: 'outbox-only' };
  const fromAddr = process.env.EMAIL_FROM_ADDRESS || 'Divination Tarot Sanctuary <onboarding@resend.dev>';
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ from: fromAddr, to: [to], subject, html, text }),
      signal: ctrl.signal
    });
    const body = await resp.json().catch(() => ({}));
    return { sent: resp.ok, provider: 'resend', messageId: body.id || null, status: resp.status };
  } catch (_) {
    return { sent: false, provider: 'resend-error' };
  } finally {
    clearTimeout(t);
  }
}

function resolveRp(req) {
  const base = process.env.PUBLIC_BASE_URL || 'https://divination-tarot-pi.vercel.app';
  let rpId = 'divination-tarot-pi.vercel.app';
  try { rpId = new URL(base).hostname; } catch (_) {}
  const h = String(req.headers?.host || '').split(':')[0];
  if (h && (h === 'localhost' || h.endsWith('.vercel.app') || h.endsWith('divinationtarot.app'))) rpId = h;
  const origins = Array.from(new Set([base, h ? `https://${h}` : base, h ? `http://${h}` : base]));
  return { rpId, origins };
}

module.exports = async function handler(req, res) {
  const u = new URL(req.url || '/', `https://${req.headers?.host || 'localhost'}`);
  const p = u.pathname;
  const m = req.method || 'GET';
  const db = getPool();

  try {
    if (p === '/api/health') {
      return send(res, 200, { status: 'ok', service: 'Divination Tarot Engine', version: '18.2.0', driver: db ? 'postgres' : 'local-fallback', aiConfigured: Boolean(process.env.GEMINI_API_KEY), emailConfigured: Boolean(process.env.RESEND_API_KEY), canonicalCards: 78 });
    }
    if (p === '/api/readyz') {
      if (!db) return send(res, 200, { ready: true, version: '18.2.0', driver: 'local-fallback' });
      const { rows } = await db.query("SELECT count(*)::int AS cnt FROM pg_tables WHERE schemaname = 'public'");
      return send(res, 200, { ready: rows[0].cnt >= 50, version: '18.2.0', driver: 'postgres', publicTables: rows[0].cnt });
    }
    if (p === '/api/public/rollout-status') {
      return send(res, 200, { ok: true, version: '18.2.0', registrationMode: 'open', livePaymentsApproved: false });
    }
    if (p === '/api/legal/policies') {
      return send(res, 200, { ok: true, version: '2026.11-rc1', policies: [] });
    }
    if (p === '/api/aura/teleprompter' && m === 'POST') {
      const body = await readBody(req);
      const q = String(body.client_query || 'What energy is emerging in my path today?').slice(0, 240);
      const cards = Array.isArray(body.drawn_cards) ? body.drawn_cards : [];
      const cardCues = cards.map((dc, i) => {
        const c = CANON_78[Number(dc.canonical_index || 0)] || CANON_78[0];
        const orient = dc.orientation === 'reversed' ? 'Reversed' : 'Upright';
        return { positionLabel: dc.position_label || `Slot ${i + 1}`, cardName: c.full, orientation: orient, activeOutput: `Anchor ${c.full} (${orient}) around "${q}" with grounded agency.`, symbolicTooltips: [c.arcana, c.suit] };
      });
      const aiSummary = await callGeminiFlash(
        'You are Aura, a reflective, non-deterministic Tarot Sanctuary mentor. Never make medical, legal, or financial predictions. Keep synthesis under 90 words.',
        `Seeker inquiry: "${q}". Drawn spread: ${cardCues.map((c) => `${c.positionLabel}: ${c.cardName} (${c.orientation})`).join('; ') || 'Single reflective draw'}. Offer a warm, grounded synthesis.`
      );
      if (aiSummary && cardCues.length > 0) {
        cardCues[0].activeOutput = aiSummary;
      }
      
      return send(res, 200, {
        ok: true,
        provider: aiSummary ? 'gemini-2.5-flash' : 'canonical-deterministic',
        teleprompter: {
          rankLabel: String(body.user_rank || 'Novice'),
          cardCues,
          signalWarnings: [],
          predictiveFollowUpMcqs: [
            { id: 'q1', label: 'Daily Grounding', prompt: 'Where does this pattern show up in your daily routine this week?' },
            { id: 'q2', label: 'Hidden Friction', prompt: 'Which assumption are you ready to release before stepping forward?' },
            { id: 'q3', label: 'Next Threshold', prompt: 'What single concrete boundary supports your clarity over the next 7 days?' },
            { id: 'q4', label: 'Closing Integration', prompt: 'What message from this spread feels most actionable right now?' }
          ],
          voiceReadout: { fullTranscript: cardCues.map((c) => c.activeOutput).join(' ') }
        }
      });
    }

    if (p === '/api/cron/outbox-and-retention' && m === 'GET') {
      const secret = String(process.env.CRON_SECRET || process.env.DATA_ENCRYPTION_KEY || '');
      const tok = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
      const tb = Buffer.from(tok), sb = Buffer.from(secret);
      if (!tok || !sb.length || tb.length !== sb.length || !crypto.timingSafeEqual(tb, sb)) {
        return send(res, 401, { error: { code: 'CRON_UNAUTHORIZED', message: 'Valid CRON_SECRET Bearer token required.' } });
      }
      if (!db) return send(res, 200, { ok: true, driver: 'no-db' });
      const nowIso = new Date().toISOString();
      const cut90 = new Date(Date.now() - 90 * 86400000).toISOString();
      const [c1, c2, c3, c4] = await Promise.all([
        db.query('DELETE FROM webauthn_challenges WHERE expires_at < $1', [nowIso]),
        db.query('DELETE FROM sessions WHERE (revoked_at IS NOT NULL OR expires_at < $1) AND created_at < $2', [nowIso, cut90]),
        db.query('DELETE FROM account_security_tokens WHERE consumed_at IS NOT NULL OR expires_at < $1', [nowIso]),
        db.query("DELETE FROM reading_sessions WHERE status = 'abandoned' AND updated_at < $1", [cut90])
      ]);
      return send(res, 200, {
        ok: true,
        expiredChallengesPruned: c1.rowCount || 0,
        retentionPruned: { expiredOrRevokedSessions: c2.rowCount || 0, expiredSecurityTokens: c3.rowCount || 0, abandonedDraftSessions: c4.rowCount || 0 }
      });
    }

    if (!db) return send(res, 503, { error: { code: 'DB_UNCONFIGURED', message: 'DATABASE_URL is required.' } });

    if (p === '/api/auth/me' && m === 'GET') {
      const auth = await getSessionAuth(db, req);
      if (!auth) return send(res, 200, { authenticated: false, user: null });
      return send(res, 200, await buildBootstrap(db, auth, auth.csrf_token));
    }

    if (p === '/api/auth/register' && m === 'POST') {
      const b = await readBody(req);
      const email = String(b.email || '').trim().toLowerCase();
      const rawH = String(b.handle || '').trim().replace(/^@+/, '');
      const handle = `@${rawH.toLowerCase()}`;
      const displayName = String(b.displayName || rawH || 'Seeker').trim().slice(0, 64);
      const password = String(b.password || '');
      if (!email.includes('@') || !rawH || password.length < 6) {
        return send(res, 400, { error: { message: 'Valid displayName, @handle, email, and 6+ char passphrase required.' } });
      }
      const dup = await db.query('SELECT id FROM users WHERE LOWER(email) = $1 OR LOWER(handle) = $2 LIMIT 1', [email, handle]);
      if (dup.rows.length) return send(res, 409, { error: { message: 'Account with that email or @handle already exists.' } });

      const userId = uid('usr'), deckId = uid('deck'), sessId = uid('ses');
      const rawTok = b64u(crypto.randomBytes(32)), csrf = b64u(crypto.randomBytes(24));
      const expIso = new Date(Date.now() + 30 * 86400000).toISOString();

      const client = await db.connect();
      try {
        await client.query('BEGIN');
        await client.query(
          `INSERT INTO users (id, handle, display_name, email, password_hash, xp, level, astral_shards, moonwater_vials, primary_role)
           VALUES ($1, $2, $3, $4, $5, 0, 1, 540, 6, 'registered_member')`,
          [userId, handle, displayName, email, hashPw(password)]
        );
        await client.query(
          `INSERT INTO decks (id, owner_id, name, description, is_active, is_showcased) VALUES ($1, $2, $3, $4, 1, 1)`,
          [deckId, userId, `${displayName}'s 78-Card Deck`, 'Complete 78-card Living Tarot Deck']
        );
        const vals = [];
        const ph = CANON_78.map((c, i) => {
          const o = i * 14;
          const serial = `DIV-${String(c.idx).padStart(2, '0')}-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
          vals.push(uid('card'), userId, deckId, c.idx, c.full, c.arcana, c.suit, c.num, c.name, c.p1, c.p2, serial, `/assets/cards/deck78_${String(c.idx).padStart(2, '0')}.webp`, handle);
          return `($${o+1},$${o+2},$${o+3},$${o+4},$${o+5},$${o+6},$${o+7},$${o+8},100,0,3.15,0.14,0,0,'none',0,$2,$${o+14},$${o+9},'Gilded Art Nouveau',$${o+10},$${o+11},'obsidian','[]',0,$${o+12},$${o+13},1,100,100,100,100,100,0,0,'{}',1)`;
        });
        await client.query(
          `INSERT INTO card_entities (id,owner_id,deck_id,canonical_index,canonical_name,arcana_type,suit,rank_label,vitality,is_destroyed,mass_grams,friction_coeff,karma,readings_count,blessing,is_custom_forged,forged_by_id,forged_by_handle,custom_title,style_prompt,palette_primary,palette_secondary,border_material,locked_symbols_json,is_showcased,serial_number,original_artwork_url,artwork_revision,surface_condition,edge_condition,corner_condition,structural_integrity,max_structural_cap,card_xp,familiarity_score,individual_metadata_json,version_seq) VALUES ${ph.join(',')}`,
          vals
        );
        await client.query(
          `INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4, $5)`,
          [sessId, userId, sha256(rawTok), csrf, expIso]
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
      await sendResendEmail({
        to: email,
        subject: 'Welcome to Divination Tarot Sanctuary — Your 78-Card Living Deck is Consecrated',
        html: `<div style="font-family:Georgia,serif;background:#120f24;color:#f8fafc;padding:24px;border-radius:12px;border:1px solid #d4af37"><h2 style="color:#fcd34d;margin-top:0">Welcome, ${displayName} (${handle})</h2><p>Your consecrated 78-card Living Tarot Deck is active in the Sanctuary. Private reading and CRM notes remain strictly encrypted and are never included in emails.</p></div>`,
        text: `Welcome to Divination Tarot Sanctuary, ${displayName} (${handle})! Your 78-card Living Deck is ready.`
      });
      
      res.setHeader('Set-Cookie', `div_sid=${encodeURIComponent(rawTok)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
      const uRow = (await db.query('SELECT * FROM users WHERE id = $1', [userId])).rows[0];
      return send(res, 201, await buildBootstrap(db, uRow, csrf));
    }

    if (p === '/api/auth/login' && m === 'POST') {
      const b = await readBody(req);
      const ident = String(b.identifier || b.email || '').trim().toLowerCase();
      const { rows } = await db.query('SELECT * FROM users WHERE LOWER(email) = $1 OR LOWER(handle) = $2 LIMIT 1', [ident, ident.startsWith('@') ? ident : `@${ident}`]);
      const uRow = rows[0];
      if (!uRow || !verifyPw(b.password || '', uRow.password_hash)) {
        return send(res, 401, { error: { message: 'Invalid email/handle or passphrase.' } });
      }
      const rawTok = b64u(crypto.randomBytes(32)), csrf = b64u(crypto.randomBytes(24));
      await db.query(
        `INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES ($1, $2, $3, $4, $5)`,
        [uid('ses'), uRow.id, sha256(rawTok), csrf, new Date(Date.now() + 30 * 86400000).toISOString()]
      );
      res.setHeader('Set-Cookie', `div_sid=${encodeURIComponent(rawTok)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
      return send(res, 200, await buildBootstrap(db, uRow, csrf));
    }

    if (p === '/api/auth/logout' && m === 'POST') {
      const sid = parseCookies(req.headers?.cookie).div_sid;
      if (sid) await db.query('UPDATE sessions SET revoked_at = CURRENT_TIMESTAMP WHERE token_hash = $1', [sha256(sid)]);
      res.setHeader('Set-Cookie', 'div_sid=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
      return send(res, 200, { ok: true });
    }

    if (p === '/api/auth/passkeys/login/options' && m === 'POST') {
      const b = await readBody(req);
      const { rpId } = resolveRp(req);
      const ch = b64u(crypto.randomBytes(32));
      let uidVal = null, allowCredentials = [];
      if (b.email) {
        const uRes = await db.query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [String(b.email).trim().toLowerCase()]);
        if (uRes.rows[0]) {
          uidVal = uRes.rows[0].id;
          const pks = await db.query('SELECT credential_id FROM user_passkeys WHERE user_id = $1', [uidVal]);
          allowCredentials = pks.rows.map((r) => ({ type: 'public-key', id: r.credential_id, transports: ['internal'] }));
        }
      }
      await db.query(`INSERT INTO webauthn_challenges (id, user_id, challenge_b64u, flow_type, rp_id, expires_at) VALUES ($1,$2,$3,'authentication',$4,$5)`,
        [uid('wac'), uidVal, ch, rpId, new Date(Date.now() + 300000).toISOString()]);
      return send(res, 200, { ok: true, options: { challenge: ch, rpId, timeout: 300000, userVerification: 'preferred', allowCredentials } });
    }

    if (p === '/api/auth/passkeys/login/verify' && m === 'POST') {
      const b = await readBody(req);
      const chRes = await db.query(`SELECT * FROM webauthn_challenges WHERE challenge_b64u = $1 AND flow_type = 'authentication' AND consumed_at IS NULL LIMIT 1`, [b.challenge]);
      const chRow = chRes.rows[0];
      if (!chRow || new Date(chRow.expires_at).getTime() < Date.now()) return send(res, 400, { error: { message: 'Passkey challenge expired.' } });
      const pkRes = await db.query('SELECT * FROM user_passkeys WHERE credential_id = $1 LIMIT 1', [b.credentialId]);
      const pkRow = pkRes.rows[0];
      if (!pkRow) return send(res, 401, { error: { message: 'Passkey not recognized.' } });

      const cdBuf = fromB64u(b.clientDataJSON);
      const cd = JSON.parse(cdBuf.toString('utf8'));
      const { origins } = resolveRp(req);
      if (cd.type !== 'webauthn.get' || cd.challenge !== b.challenge || !origins.includes(cd.origin)) {
        return send(res, 401, { error: { message: 'WebAuthn clientData mismatch.' } });
      }
      const adBuf = fromB64u(b.authenticatorData);
      const rpHash = crypto.createHash('sha256').update(String(chRow.rp_id)).digest();
      if (adBuf.length < 37 || !crypto.timingSafeEqual(adBuf.subarray(0, 32), rpHash) || !(adBuf.readUInt8(32) & 0x01)) {
        return send(res, 401, { error: { message: 'WebAuthn authenticatorData invalid.' } });
      }
      const nextCnt = adBuf.readUInt32BE(33);
      if (Number(pkRow.sign_count) > 0 && nextCnt > 0 && nextCnt <= Number(pkRow.sign_count)) {
        return send(res, 401, { error: { message: 'Cloned authenticator signCount regression detected.' } });
      }
      const keyObj = crypto.createPublicKey({ key: Buffer.from(pkRow.public_key_spki_b64, 'base64'), format: 'der', type: 'spki' });
      const payload = Buffer.concat([adBuf, crypto.createHash('sha256').update(cdBuf).digest()]);
      if (!crypto.verify('sha256', payload, keyObj, fromB64u(b.signature))) {
        return send(res, 401, { error: { message: 'Passkey signature verification failed.' } });
      }

      const rawTok = b64u(crypto.randomBytes(32)), csrf = b64u(crypto.randomBytes(24));
      await db.query('UPDATE webauthn_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [chRow.id]);
      await db.query('UPDATE user_passkeys SET sign_count = $1, last_used_at = CURRENT_TIMESTAMP WHERE id = $2', [nextCnt, pkRow.id]);
      await db.query('INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at) VALUES ($1,$2,$3,$4,$5)',
        [uid('ses'), pkRow.user_id, sha256(rawTok), csrf, new Date(Date.now() + 30 * 86400000).toISOString()]);
      res.setHeader('Set-Cookie', `div_sid=${encodeURIComponent(rawTok)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`);
      const uRow = (await db.query('SELECT * FROM users WHERE id = $1', [pkRow.user_id])).rows[0];
      return send(res, 200, { ok: true, authenticatedVia: 'webauthn_passkey', ...(await buildBootstrap(db, uRow, csrf)) });
    }

    const auth = await getSessionAuth(db, req);
    if (!auth) return send(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Authentication required.' } });

    if (p === '/api/auth/security-state' && m === 'GET') {
      const sCnt = await db.query('SELECT count(*)::int AS cnt FROM sessions WHERE user_id = $1 AND revoked_at IS NULL', [auth.id]);
      return send(res, 200, {
        securityProfile: { emailVerified: Boolean(auth.email_verified), mfaEnabled: Boolean(auth.mfa_enabled), primaryRole: auth.primary_role || 'registered_member', effectiveRoles: [auth.primary_role || 'registered_member'], activeSessionsCount: sCnt.rows[0].cnt },
        privacySettings: { publicProfileVisible: true, showcaseVisible: true, allowPublicBookings: true, aiExternalProcessingConsent: true, analyticsTelemetryOptIn: false }
      });
    }
    if (p === '/api/auth/passkeys' && m === 'GET') {
      const { rows } = await db.query('SELECT id, credential_id, device_label, sign_count, last_used_at, created_at FROM user_passkeys WHERE user_id = $1 ORDER BY created_at DESC', [auth.id]);
      return send(res, 200, { ok: true, passkeys: rows.map((r) => ({ id: r.id, credentialId: r.credential_id, deviceLabel: r.device_label, signCount: Number(r.sign_count || 0), lastUsedAt: r.last_used_at, createdAt: r.created_at })) });
    }
    if (p === '/api/auth/passkeys/register/options' && m === 'POST') {
      const { rpId } = resolveRp(req);
      const ch = b64u(crypto.randomBytes(32));
      await db.query(`INSERT INTO webauthn_challenges (id, user_id, challenge_b64u, flow_type, rp_id, expires_at) VALUES ($1,$2,$3,'registration',$4,$5)`,
        [uid('wac'), auth.id, ch, rpId, new Date(Date.now() + 300000).toISOString()]);
      return send(res, 200, { ok: true, options: { rp: { name: 'Divination Tarot Sanctuary', id: rpId }, user: { id: b64u(Buffer.from(auth.id)), name: auth.handle, displayName: auth.display_name }, challenge: ch, pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }], timeout: 300000, attestation: 'none', excludeCredentials: [] } });
    }
    if (p === '/api/auth/passkeys/register/verify' && m === 'POST') {
      const b = await readBody(req);
      const chRes = await db.query(`SELECT * FROM webauthn_challenges WHERE challenge_b64u = $1 AND user_id = $2 AND flow_type = 'registration' AND consumed_at IS NULL LIMIT 1`, [b.challenge, auth.id]);
      if (!chRes.rows[0]) return send(res, 400, { error: { message: 'Invalid or expired registration challenge.' } });
      crypto.createPublicKey({ key: Buffer.from(b.publicKeySpkiB64, 'base64'), format: 'der', type: 'spki' });
      const pkId = uid('psk');
      await db.query('UPDATE webauthn_challenges SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [chRes.rows[0].id]);
      await db.query('INSERT INTO user_passkeys (id, user_id, credential_id, public_key_spki_b64, algorithm_cose, device_label) VALUES ($1,$2,$3,$4,$5,$6)',
        [pkId, auth.id, b.credentialId, b.publicKeySpkiB64, Number(b.algorithmCose || -7), String(b.deviceLabel || 'Biometric Passkey').slice(0, 80)]);
      return send(res, 201, { ok: true, passkeyId: pkId });
    }
    if (p.startsWith('/api/auth/passkeys/') && m === 'DELETE') {
      const pkId = decodeURIComponent(p.split('/').pop());
      await db.query('DELETE FROM user_passkeys WHERE id = $1 AND user_id = $2', [pkId, auth.id]);
      return send(res, 200, { ok: true, deletedId: pkId });
    }
    if (p === '/api/notifications' && m === 'GET') {
      return send(res, 200, { notifications: [], unreadCount: 0 });
    }
    if (p === '/api/blueprint/status' && m === 'GET') {
      return send(res, 200, { ok: true, rank: { key: auth.blueprint_rank || 'novice' }, immortalDeckProgress: { immortalSlots: 0, requiredSlots: 78 } });
    }
    
    if (p.startsWith('/api/ai/assistants/') && m === 'POST') {
      const role = decodeURIComponent(p.split('/').pop());
      const b = await readBody(req);
      const prompt = String(b.prompt || 'Explain Major Arcana structure.');
      const aiText = await callGeminiFlash(
        `You are the Divination Tarot ${role.replace(/_/g, ' ')}. Offer reflective, historically grounded symbolism insights under 140 words without deterministic fortune-telling.`,
        prompt
      );
      return send(res, 200, {
        ok: true,
        provider: aiText ? 'gemini-2.5-flash' : 'canonical-deterministic',
        response: aiText || '[Canonical Synthesis] Tarot symbolism invites reflective dialogue between archetypal structure and personal agency.'
      });
    }
    if (p === '/api/auth/verify-email/request' && m === 'POST') {
      const rawTok = b64u(crypto.randomBytes(24));
      await db.query(
        `INSERT INTO account_security_tokens (id, user_id, token_purpose, token_sha256, target_email, expires_at) VALUES ($1,$2,'email_verification',$3,$4,$5)`,
        [uid('stk'), auth.id, sha256(rawTok), auth.email, new Date(Date.now() + 3600000).toISOString()]
      );
      const delivery = await sendResendEmail({
        to: auth.email,
        subject: 'Verify Your Divination Tarot Sanctuary Email',
        html: `<div style="font-family:Georgia,serif;background:#120f24;color:#f8fafc;padding:24px;border-radius:12px;border:1px solid #d4af37"><h2 style="color:#fcd34d;margin-top:0">Verify Your Sanctuary Email</h2><p>Enter verification code: <strong style="color:#6ee7b7">${rawTok}</strong></p></div>`,
        text: `Verify your Divination Tarot Sanctuary email with token: ${rawTok}`
      });
      return send(res, 200, { ok: true, emailSent: delivery.sent, provider: delivery.provider, ...(delivery.sent ? {} : { sandboxVerificationToken: rawTok }) });
    }
    if (p === '/api/auth/verify-email/confirm' && m === 'POST') {
      const b = await readBody(req);
      const r = await db.query(
        `SELECT id FROM account_security_tokens WHERE user_id = $1 AND token_purpose = 'email_verification' AND token_sha256 = $2 AND consumed_at IS NULL AND expires_at > $3 LIMIT 1`,
        [auth.id, sha256(String(b.token || '').trim()), new Date().toISOString()]
      );
      if (!r.rows[0]) return send(res, 400, { error: { message: 'Invalid or expired verification token.' } });
      await db.query('UPDATE account_security_tokens SET consumed_at = CURRENT_TIMESTAMP WHERE id = $1', [r.rows[0].id]);
      await db.query('UPDATE users SET email_verified = 1, email_verified_at = CURRENT_TIMESTAMP WHERE id = $1', [auth.id]);
      return send(res, 200, { ok: true, emailVerified: true });
    } 
    //}

    return send(res, 404, { error: { code: 'NOT_FOUND', message: `Route ${m} ${p} not found.` } });
  } catch (err) {
    return send(res, 500, { error: { code: 'INTERNAL_ERROR', message: err.message || 'Server error.' } });
  }
};
