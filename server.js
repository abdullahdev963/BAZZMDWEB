// language: JavaScript, file: server.js, runtime: Node 20+
import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} from '@whiskeysockets/baileys';
import P from 'pino';
import { Boom } from '@hapi/boom';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './config.js';
import { handleMessage, handleCall } from './handler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const sessions = new Map();

if (!fs.existsSync(config.sessionDir)) fs.mkdirSync(config.sessionDir, { recursive: true });

async function createSession(number) {
  const dir = path.join(config.sessionDir, number);
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    logger: P({ level: 'silent' }),
    printQRInTerminal: false,
    auth: state,
    browser: ['BAZZ MD', 'Chrome', '1.0.0'],
    syncFullHistory: false,
    markOnlineOnConnect: false,
    generateHighQualityLinkPreview: true
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (u) => {
    const { connection, lastDisconnect } = u;
    if (connection === 'open') console.log(`${number} connected.`);
    if (connection === 'close') {
      const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
      if (code !== DisconnectReason.loggedOut) {
        console.log(`Reconnect ${number}...`);
        setTimeout(() => createSession(number), 3000);
      } else {
        sessions.delete(number);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  sock.ev.on('messages.upsert', async (upsert) => {
    try { await handleMessage(sock, upsert); }
    catch (e) { console.error('handler err:', e.message); }
  });

  sock.ev.on('call', async (calls) => {
    try { await handleCall(sock, calls); }
    catch (e) { console.error('call err:', e.message); }
  });

  sessions.set(number, sock);
  return sock;
}

app.post('/pair', async (req, res) => {
  const { number } = req.body;
  if (!number || !/^\d{10,15}$/.test(number)) {
    return res.status(400).json({ error: 'Number galat hai' });
  }

  try {
    let sock = sessions.get(number);
    if (!sock) sock = await createSession(number);

    if (!sock.authState.creds.registered) {
      await new Promise(r => setTimeout(r, 3000));
      const code = await sock.requestPairingCode(number);
      return res.json({ code });
    }
    res.json({ message: 'Pehle se registered' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message || 'Pairing fail' });
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Panel on ${PORT}`));
