// Self-hosted WhatsApp bridge for the Itai Bar Mitzvah dashboard.
// Uses baileys to keep a personal WhatsApp session and exposes HTTP endpoints
// that the Base44 "whatsapp-bridge" function proxies to.
//
// Endpoints (all POST, JSON body, require { token } matching BRIDGE_TOKEN):
//   POST /qr         -> { qr: <data-url image> } | { connected: true, phone }
//   POST /status     -> { connected: boolean, phone?: string }
//   POST /send       -> { to, text, imageUrl? } -> { ok: true }
//   POST /send-bulk  -> { items: [{ to, text, id }], imageUrl? } -> { ok, sentIds }
//
// Incoming messages are forwarded to the Base44 "whatsapp-webhook" function
// as { token, from, message, ts }, so RSVP replies auto-update the Guest entity.

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const QR = require('qrcode');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const pino = require('pino');

const PORT = process.env.PORT || 3000;
const logger = pino({ level: 'silent' });
const TOKEN = process.env.BRIDGE_TOKEN || 'change-me';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const AUTH_DIR = path.join(__dirname, 'auth_state');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

let sock = null;
let lastQr = null;       // data-url image
let connected = false;
let connectionPhone = null;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger,
    browser: ['ItaiBarMitzvah', 'Chrome', '1.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update;
    if (qr) {
      try {
        lastQr = await QR.toDataURL(qr);
      } catch {
        lastQr = null;
      }
    }
    if (connection === 'open') {
      connected = true;
      lastQr = null;
      const me = sock.user;
      connectionPhone = me ? '+' + String(me.id).split(':')[0] : null;
      console.log('WhatsApp connected:', connectionPhone);
    }
    if (connection === 'close') {
      connected = false;
      lastQr = null;
      const code = lastDisconnect?.error instanceof Boom
        ? lastDisconnect.error.output.statusCode
        : undefined;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log('Connection closed. Reconnect?', shouldReconnect);
      if (shouldReconnect) setTimeout(startSock, 3000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' = live incoming; 'append' = history sync (e.g. messages that
    // arrived while the bridge was briefly asleep). Process both so RSVP
    // replies are never missed — the webhook update is idempotent.
    if ((type !== 'notify' && type !== 'append') || !WEBHOOK_URL) return;
    const now = Date.now();
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      // Skip stale history-sync messages older than 2 hours
      const ts = msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : null;
      if (ts && now - ts > 2 * 60 * 60 * 1000) continue;
      const from = String(msg.key.remoteJid || '').split('@')[0];
      const text =
        msg.message?.conversation ||
        msg.message?.extendedTextMessage?.text ||
        msg.message?.imageMessage?.caption ||
        msg.message?.videoMessage?.caption ||
        '';
      if (!from || !text) continue;
      try {
        await axios.post(WEBHOOK_URL, {
          token: TOKEN,
          from,
          message: text,
          ts: ts || Date.now(),
        });
      } catch (e) {
        console.error('Webhook forward failed:', e.message);
      }
    }
  });
}

function authMiddleware(req, res, next) {
  if (req.body.token !== TOKEN) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function toJid(to) {
  if (!to) return '';
  if (String(to).includes('@')) return to;
  const digits = String(to).replace(/\D/g, '');
  return digits + '@s.whatsapp.net';
}

app.get('/', (_req, res) => res.send('WhatsApp bridge is running'));

app.post('/qr', authMiddleware, async (_req, res) => {
  if (connected) return res.json({ connected: true, phone: connectionPhone });
  if (lastQr) return res.json({ qr: lastQr });
  // No QR cached yet — poll for up to ~25s for baileys to generate one.
  // Do NOT call sock.end(): that would kill the in-progress connection that
  // is about to produce the QR, which is the root cause of the repeated
  // "QR not ready yet" errors on cold starts (e.g. Render free tier wake-up).
  const deadline = Date.now() + 25000;
  const wait = () => {
    if (connected) return res.json({ connected: true, phone: connectionPhone });
    if (lastQr) return res.json({ qr: lastQr });
    if (Date.now() > deadline) {
      return res.json({ error: 'QR not ready yet — click again in a few seconds' });
    }
    setTimeout(wait, 1000);
  };
  wait();
});

app.post('/status', authMiddleware, (_req, res) => {
  res.json({ connected, phone: connectionPhone });
});

// Diagnostic: reports whether WEBHOOK_URL is set and tests forwarding a payload
// to the Base44 whatsapp-webhook function. Helps debug why incoming RSVP
// replies aren't updating the dashboard.
app.post('/webhook-diag', authMiddleware, async (_req, res) => {
  const result = {
    webhookUrlSet: Boolean(WEBHOOK_URL),
    webhookUrl: WEBHOOK_URL ? WEBHOOK_URL.replace(/token=[^&]*/g, 'token=***') : null,
    forwardOk: false,
    forwardStatus: null,
    forwardBody: null,
    error: null,
  };
  if (!WEBHOOK_URL) {
    return res.json(result);
  }
  try {
    const r = await axios.post(
      WEBHOOK_URL,
      { token: TOKEN, from: '0000000000', message: 'diag' },
      { timeout: 10000 }
    );
    result.forwardOk = true;
    result.forwardStatus = r.status;
    result.forwardBody = r.data;
  } catch (e) {
    result.error = e.message;
    result.forwardStatus = e.response ? e.response.status : null;
    result.forwardBody = e.response ? e.response.data : null;
  }
  res.json(result);
});

app.post('/send', authMiddleware, async (req, res) => {
  try {
    const { to, text, imageUrl } = req.body;
    if (!connected) return res.status(503).json({ error: 'WhatsApp not connected' });
    const jid = toJid(to);
    if (imageUrl) {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(imgRes.data, 'binary');
      await sock.sendMessage(jid, { image: buffer, caption: text || undefined });
    } else {
      await sock.sendMessage(jid, { text });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/send-bulk', authMiddleware, async (req, res) => {
  try {
    const { items = [], imageUrl } = req.body;
    if (!connected) return res.status(503).json({ error: 'WhatsApp not connected' });
    const sentIds = [];
    for (const item of items) {
      const jid = toJid(item.to);
      if (imageUrl) {
        const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(imgRes.data, 'binary');
        await sock.sendMessage(jid, { image: buffer, caption: item.text || undefined });
      } else {
        await sock.sendMessage(jid, { text: item.text });
      }
      sentIds.push(item.id);
      await new Promise((r) => setTimeout(r, 800)); // avoid rate limits
    }
    res.json({ ok: true, sentIds });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

startSock();

app.listen(PORT, () => console.log('WhatsApp bridge listening on port', PORT));
