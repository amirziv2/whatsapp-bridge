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

const PORT = process.env.PORT || 3000;
const TOKEN = process.env.BRIDGE_TOKEN || 'change-me';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const AUTH_DIR = path.join(__dirname, 'auth_state');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

let sock = null, lastQr = null, connected = false, connectionPhone = null;

async function startSock() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();
  sock = makeWASocket({
    version, auth: state, printQRInTerminal: false,
    logger: { level: 'silent' },
    browser: ['ItaiBarMitzvah', 'Chrome', '1.0.0'],
  });
  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', async (u) => {
    const { connection, qr, lastDisconnect } = u;
    if (qr) { try { lastQr = await QR.toDataURL(qr); } catch { lastQr = null; } }
    if (connection === 'open') {
      connected = true; lastQr = null;
      const me = sock.user;
      connectionPhone = me ? '+' + String(me.id).split(':')[0] : null;
    }
    if (connection === 'close') {
      connected = false; lastQr = null;
      const code = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output.statusCode : undefined;
      if (code !== DisconnectReason.loggedOut) setTimeout(startSock, 3000);
    }
  });
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify' || !WEBHOOK_URL) return;
    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      const from = String(msg.key.remoteJid || '').split('@')[0];
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text
        || msg.message?.imageMessage?.caption || msg.message?.videoMessage?.caption || '';
      if (!from || !text) continue;
      try { await axios.post(WEBHOOK_URL, { token: TOKEN, from, message: text }); }
      catch (e) { console.error('Webhook forward failed:', e.message); }
    }
  });
}

const auth = (req, res, next) => {
  if (req.body.token !== TOKEN) return res.status(401).json({ error: 'Unauthorized' });
  next();
};
const toJid = (to) => !to ? '' : (String(to).includes('@') ? to : String(to).replace(/\D/g, '') + '@s.whatsapp.net');

app.get('/', (_req, res) => res.send('WhatsApp bridge is running'));
app.post('/qr', auth, (_req, res) => {
  if (connected) return res.json({ connected: true, phone: connectionPhone });
  if (lastQr) return res.json({ qr: lastQr });
  try { if (sock && typeof sock.end === 'function') sock.end(); } catch {}
  res.json({ error: 'QR not ready yet — click again in a few seconds' });
});
app.post('/status', auth, (_req, res) => res.json({ connected, phone: connectionPhone }));
app.post('/send', auth, async (req, res) => {
  try {
    const { to, text, imageUrl } = req.body;
    if (!connected) return res.status(503).json({ error: 'WhatsApp not connected' });
    const jid = toJid(to);
    if (imageUrl) {
      const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
      await sock.sendMessage(jid, { image: Buffer.from(imgRes.data, 'binary'), caption: text || undefined });
    } else { await sock.sendMessage(jid, { text }); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/send-bulk', auth, async (req, res) => {
  try {
    const { items = [], imageUrl } = req.body;
    if (!connected) return res.status(503).json({ error: 'WhatsApp not connected' });
    const sentIds = [];
    for (const item of items) {
      const jid = toJid(item.to);
      if (imageUrl) {
        const imgRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        await sock.sendMessage(jid, { image: Buffer.from(imgRes.data, 'binary'), caption: item.text || undefined });
      } else { await sock.sendMessage(jid, { text: item.text }); }
      sentIds.push(item.id);
      await new Promise(r => setTimeout(r, 800));
    }
    res.json({ ok: true, sentIds });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

startSock();
app.listen(PORT, () => console.log('WhatsApp bridge listening on port', PORT))
