// language: JavaScript, file: handler.js
import fs from 'fs';
import axios from 'axios';
import yts from 'yt-search';
import ytdl from '@distube/ytdl-core';
import qrcode from 'qrcode';
import translate from 'translate-google';
import moment from 'moment-timezone';
import config from './config.js';
import { db, saveDB } from './database.js';

const P = config.prefix;

const http = axios.create({
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

const groupSettings = db.groups || {};
function getGroupSettings(jid) {
  if (!groupSettings[jid]) {
    groupSettings[jid] = {
      antilink: false, antispam: false, antitoxic: false,
      antidelete: false, welcome: false, bye: false,
      autoreact: false, anticall: false
    };
  }
  return groupSettings[jid];
}
function saveGroups() { db.groups = groupSettings; saveDB(); }

const autoReact = db.autoReact || {};
const emojiPool = ['❤️','🔥','👍','😂','😮','💯','⚡','🎯','👑','✨'];
const antiCall = db.antiCall || { enabled: false };

const personas = {
  jaan: `Tum ek romantic ladki ho, naam "Jaan". User se pyar karti ho. Jawab Roman Urdu me, chhota, warm, dil se. Max 2 lines.`,
  gf: `Caring girlfriend. Roman Urdu. Max 2 lines.`,
  dost: `Mazedaar dost. Roman Urdu. Max 2 lines.`,
  teacher: `Helpful teacher. Roman Urdu. Max 3 lines.`,
  philosopher: `Philosopher. Roman Urdu. Max 2 lines.`,
  default: `Helpful AI. Roman Urdu. Max 3 lines.`
};

const aiCache = new Map();

async function askAI(prompt, persona = 'default') {
  const key = config.geminiKey;
  if (!key || key === 'YOUR_GEMINI_API_KEY_HERE') throw new Error('Gemini key missing');

  const cacheKey = persona + ':' + prompt.toLowerCase().trim();
  if (aiCache.has(cacheKey)) return aiCache.get(cacheKey);

  const sys = personas[persona] || personas.default;
  const model = config.geminiModel || 'gemini-2.0-flash-lite';

  const res = await http.post(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      contents: [{ role: 'user', parts: [{ text: sys + '\n\nUser: ' + prompt }] }],
      generationConfig: { temperature: 0.95, maxOutputTokens: 150, topP: 0.9 }
    },
    { headers: { 'Content-Type': 'application/json' } }
  );

  const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('No response');
  const clean = text.trim();
  if (aiCache.size > 200) aiCache.clear();
  aiCache.set(cacheKey, clean);
  return clean;
}

async function sendVoice(sock, jid, text) {
  try {
    const lang = /[\u0600-\u06FF]/.test(text) ? 'ur' : 'hi';
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob&ttsspeed=0.9`;
    await sock.sendMessage(jid, {
      audio: { url }, mimetype: 'audio/mp4', ptt: true
    }, { noSelfSync: true });
  } catch {}
}

// DOWNLOADERS
async function dlTikTok(url) {
  try {
    const { data } = await http.get(`https://tikwm.com/api/?url=${encodeURIComponent(url)}&hd=1`);
    if (data?.data) return {
      video: data.data.hdplay || data.data.play,
      title: data.data.title || 'TikTok',
      author: data.data.author?.nickname || ''
    };
  } catch {}
  throw new Error('TikTok fail');
}

async function dlInstagram(url) {
  try {
    const { data } = await http.get(`https://snapinsta.app/api/ajaxSearch?q=${encodeURIComponent(url)}`, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' }
    });
    if (data?.data) {
      const html = data.data;
      const videoMatch = html.match(/href="(https:\/\/[^"]+\.mp4[^"]*)"/);
      const imgMatch = html.match(/href="(https:\/\/[^"]+\.jpg[^"]*)"/);
      if (videoMatch) return { video: videoMatch[1], title: 'Instagram' };
      if (imgMatch) return { image: imgMatch[1], title: 'Instagram' };
    }
  } catch {}
  throw new Error('Instagram fail');
}

async function dlFacebook(url) {
  try {
    const { data } = await http.get(`https://www.facebook.com/plugins/video/oembed.json/?url=${encodeURIComponent(url)}`);
    if (data?.html) {
      const src = data.html.match(/src="([^"]+)"/);
      if (src) return { video: src[1], title: 'Facebook' };
    }
  } catch {}
  throw new Error('Facebook fail');
}

async function dlTwitter(url) {
  try {
    const id = url.match(/status\/(\d+)/)?.[1];
    if (!id) throw new Error();
    const { data } = await http.get(`https://api.vxtwitter.com/Twitter/status/${id}`);
    if (data?.mediaURLs?.length) return { video: data.mediaURLs[0], title: data.description || 'Twitter' };
  } catch {}
  throw new Error('Twitter fail');
}

async function dlPinterest(url) {
  try {
    const { data } = await http.get(url);
    const vm = data.match(/<meta property="og:video" content="([^"]+)"/);
    if (vm) return { video: vm[1], title: 'Pinterest' };
    const im = data.match(/<meta property="og:image" content="([^"]+)"/);
    if (im) return { image: im[1], title: 'Pinterest' };
  } catch {}
  throw new Error('Pinterest fail');
}

async function dlYouTube(url, type = 'audio') {
  const info = await ytdl.getInfo(url);
  const title = info.videoDetails.title;
  const format = type === 'audio'
    ? ytdl.chooseFormat(info.formats, { quality: 'highestaudio', filter: 'audioonly' })
    : ytdl.chooseFormat(info.formats, { quality: 'highest', filter: 'audioandvideo' });
  return { url: format.url, title, type };
}

// SMART DECODE
function smartDecode(input) {
  const t = input.trim();
  const results = [];
  try {
    if (/^[A-Za-z0-9+/=]+$/.test(t) && t.length % 4 === 0) {
      const d = Buffer.from(t, 'base64').toString('utf8');
      if (/^[\x20-\x7E\u0600-\u06FF\s]+$/.test(d)) results.push(`*Base64:*\n${d}`);
    }
  } catch {}
  try {
    if (/^[0-9a-fA-F\s]+$/.test(t) && t.replace(/\s/g, '').length % 2 === 0) {
      const d = Buffer.from(t.replace(/\s/g, ''), 'hex').toString('utf8');
      if (/^[\x20-\x7E\u0600-\u06FF\s]+$/.test(d)) results.push(`*Hex:*\n${d}`);
    }
  } catch {}
  try {
    if (/%[0-9A-Fa-f]{2}/.test(t)) {
      const d = decodeURIComponent(t);
      if (d !== t) results.push(`*URL:*\n${d}`);
    }
  } catch {}
  try {
    if (/^[a-zA-Z\s!?.,]+$/.test(t)) {
      const d = t.replace(/[a-zA-Z]/g, c =>
        String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));
      if (d !== t) results.push(`*ROT13:*\n${d}`);
    }
  } catch {}
  try {
    if (/^[01\s]+$/.test(t) && t.replace(/\s/g, '').length % 8 === 0) {
      const d = t.trim().split(/\s+/).map(b => String.fromCharCode(parseInt(b, 2))).join('');
      if (/^[\x20-\x7E\u0600-\u06FF\s]+$/.test(d)) results.push(`*Binary:*\n${d}`);
    }
  } catch {}
  try {
    if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/.test(t)) {
      const p = JSON.parse(Buffer.from(t.split('.')[1], 'base64').toString());
      results.push(`*JWT Payload:*\n${JSON.stringify(p, null, 2)}`);
    }
  } catch {}
  if (results.length === 0) return '❌ Koi encoding detect nahi hui.';
  return results.join('\n\n');
}

export async function handleMessage(sock, { messages, type }) {
  if (type !== 'notify') return;
  for (const msg of messages) {
    try { await processMsg(sock, msg); }
    catch (e) { console.error('msg err:', e.message); }
  }
}

async function processMsg(sock, msg) {
  if (!msg.message) return;
  const from = msg.key.remoteJid;
  const isGroup = from.endsWith('@g.us');
  const sender = isGroup ? msg.key.participant : from;
  const pushName = msg.pushName || 'Unknown';
  const isOwner = sender.split('@')[0] === config.owner;

  // GROUP GUARD
  if (isGroup) {
    const meta = await sock.groupMetadata(from).catch(() => null);
    if (meta) {
      const gs = getGroupSettings(from);
      const isAdmin = meta.participants.find(p => p.id === sender)?.admin;
      const botAdmin = meta.participants.find(p => p.id === sock.user.id)?.admin;
      if (!isAdmin && botAdmin) {
        const body = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
        if (gs.antilink && /(https?:\/\/|wa\.me\/|chat\.whatsapp\.com)/i.test(body)) {
          await sock.sendMessage(from, { delete: msg.key });
          await sock.groupParticipantsUpdate(from, [sender], 'remove');
          return sock.sendMessage(from, {
            text: `🚫 Link detect. @${sender.split('@')[0]} nikal diya.`, mentions: [sender]
          }, { noSelfSync: true });
        }
        if (gs.antispam) {
          const key = `${from}:${sender}`;
          const now = Date.now();
          global._spam = global._spam || {};
          const rec = global._spam[key] || { count: 0, last: 0 };
          if (now - rec.last < 3000) rec.count++; else rec.count = 1;
          rec.last = now;
          global._spam[key] = rec;
          if (rec.count >= 6) {
            rec.count = 0;
            await sock.sendMessage(from, { delete: msg.key });
            await sock.groupParticipantsUpdate(from, [sender], 'remove');
            return sock.sendMessage(from, {
              text: `🚫 Spam detect. @${sender.split('@')[0]} nikal diya.`, mentions: [sender]
            }, { noSelfSync: true });
          }
        }
      }
      if (gs.autoreact) {
        const emoji = emojiPool[Math.floor(Math.random() * emojiPool.length)];
        await sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {});
      }
    }
  }

  if (!isGroup && autoReact[from]) {
    const emoji = emojiPool[Math.floor(Math.random() * emojiPool.length)];
    await sock.sendMessage(from, { react: { text: emoji, key: msg.key } }).catch(() => {});
  }

  const text = msg.message.conversation || msg.message.extendedTextMessage?.text || msg.message.imageMessage?.caption || '';
  if (!text.startsWith(P)) return;
  if (msg.key.fromMe) return;

  const args = text.slice(P.length).trim().split(/\s+/);
  const cmd = args.shift().toLowerCase();

  const reply = (content, opts = {}) =>
    sock.sendMessage(from, content, { noSelfSync: true, ...opts });
  const sendImage = (buffer, caption) =>
    sock.sendMessage(from, { image: buffer, caption }, { noSelfSync: true });

  // MAIN
  if (cmd === 'menu' || cmd === 'help') {
    const img = fs.existsSync(config.menuImage) ? fs.readFileSync(config.menuImage) : null;
    const caption = buildMenu(pushName);
    if (img) return sendImage(img, caption);
    return reply({ text: caption });
  }
  if (cmd === 'ping') {
    const t = Date.now();
    await reply({ text: 'Pong!' });
    return reply({ text: `⚡ ${Date.now() - t} ms` });
  }
  if (cmd === 'owner') return reply({ text: `👑 Owner: wa.me/${config.owner}` });
  if (cmd === 'info') return reply({ text: `🤖 ${config.botName}\n👑 ${config.ownerName}\n🕒 ${moment().tz(config.timezone).format('DD/MM/YYYY HH:mm')}` });
  if (cmd === 'time') return reply({ text: `🕒 ${moment().tz(config.timezone).format('dddd, DD MMM YYYY — HH:mm:ss')}` });

  // AI
  if (cmd === 'jaan' || cmd === 'romance') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ Example: ${P}jaan kaisi ho` });
    try {
      sock.sendMessage(from, { react: { text: '💕', key: msg.key } }).catch(() => {});
      const aiReply = await askAI(input, 'jaan');
      sendVoice(sock, from, aiReply).catch(() => {});
      return reply({ text: `💕 ${aiReply}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'gf') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ Example: ${P}gf kya kar rahi ho` });
    try {
      const aiReply = await askAI(input, 'gf');
      sendVoice(sock, from, aiReply).catch(() => {});
      return reply({ text: `💗 ${aiReply}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'dost' || cmd === 'friend') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ Example: ${P}dost kya haal` });
    try { return reply({ text: `😎 ${await askAI(input, 'dost')}` }); }
    catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'teacher' || cmd === 'sir') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ Example: ${P}teacher photosynthesis` });
    try { return reply({ text: `📚 ${await askAI(input, 'teacher')}` }); }
    catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'philosopher' || cmd === 'soch') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ Example: ${P}philosopher zindagi` });
    try { return reply({ text: `🧘 ${await askAI(input, 'philosopher')}` }); }
    catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'ai' || cmd === 'gpt') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ Example: ${P}ai Pakistan ka capital` });
    try {
      sock.sendMessage(from, { react: { text: '🧠', key: msg.key } }).catch(() => {});
      return reply({ text: `🧠 ${await askAI(input, 'default')}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }

  // SPAM
  if (cmd === 'spam') {
    if (!isOwner) return reply({ text: '❌ Owner only.' });
    const m = text.slice(P.length + 5).trim();
    const match = m.match(/^(.+?)\s+(\d+)$/s);
    if (!match) return reply({ text: `❌ Format: ${P}spam <text> <count> (max 500)` });
    let count = parseInt(match[2]);
    if (count > 500) count = 500;
    if (count < 1) return reply({ text: '❌ Min 1.' });
    await reply({ text: `⏳ ${count} messages...` });
    for (let i = 0; i < count; i++) {
      await sock.sendMessage(from, { text: match[1] }, { noSelfSync: true }).catch(() => {});
      await new Promise(r => setTimeout(r, 300));
    }
    return;
  }

  // GROUP GUARD TOGGLES
  if (['antilink','antispam','antitoxic','antidelete','welcome','bye'].includes(cmd)) {
    if (!isGroup) return reply({ text: '❌ Group only.' });
    if (!isOwner) return reply({ text: '❌ Owner only.' });
    const gs = getGroupSettings(from);
    gs[cmd] = !gs[cmd];
    saveGroups();
    return reply({ text: `✅ ${cmd} → ${gs[cmd] ? 'ON' : 'OFF'}` });
  }
  if (cmd === 'autoreact') {
    if (isGroup) {
      const gs = getGroupSettings(from);
      gs.autoreact = !gs.autoreact;
      saveGroups();
      return reply({ text: `✅ autoreact → ${gs.autoreact ? 'ON' : 'OFF'}` });
    }
    autoReact[from] = !autoReact[from];
    db.autoReact = autoReact;
    saveDB();
    return reply({ text: `✅ autoreact → ${autoReact[from] ? 'ON' : 'OFF'}` });
  }
  if (cmd === 'anticall') {
    if (!isOwner) return reply({ text: '❌ Owner only.' });
    antiCall.enabled = !antiCall.enabled;
    db.antiCall = antiCall;
    saveDB();
    return reply({ text: `✅ anticall → ${antiCall.enabled ? 'ON' : 'OFF'}` });
  }

  // TOOLS
  if (cmd === 'sticker' || cmd === 's') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    const target = quoted?.imageMessage || msg.message.imageMessage;
    if (!target) return reply({ text: '❌ Image reply karo.' });
    const stream = await sock.downloadMediaMessage(quoted ? { message: quoted } : msg);
    return sock.sendMessage(from, { sticker: stream }, { noSelfSync: true });
  }
  if (cmd === 'toimg') {
    const quoted = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted?.stickerMessage) return reply({ text: '❌ Sticker reply karo.' });
    const buffer = await sock.downloadMediaMessage({ message: quoted });
    return sock.sendMessage(from, { image: buffer, caption: '✅' }, { noSelfSync: true });
  }
  if (cmd === 'vv') {
    const ctx = msg.message.extendedTextMessage?.contextInfo;
    const quoted = ctx?.quotedMessage;
    if (!quoted) return reply({ text: '❌ Photo reply karke .vv' });
    const imgMsg = quoted.imageMessage || quoted.viewOnceMessage?.message?.imageMessage ||
      quoted.viewOnceMessageV2?.message?.imageMessage || quoted.viewOnceMessageV2Extension?.message?.imageMessage;
    if (!imgMsg) return reply({ text: '❌ Ye photo nahi.' });
    try {
      const buffer = await sock.downloadMediaMessage({ message: quoted, key: msg.key }, 'buffer', {});
      if (!buffer || buffer.length < 100) return reply({ text: '❌ Fail.' });
      return sock.sendMessage(from, { image: buffer, caption: '✅ HD — BY BAZZ MD' }, { noSelfSync: true });
    } catch (e) { return reply({ text: '❌ ' + e.message }); }
  }
  if (cmd === 'aivoice' || cmd === 'aiv') {
    const t = args.join(' ');
    if (!t) return reply({ text: `❌ Example: ${P}aivoice Hi BAZZ` });
    await sendVoice(sock, from, t);
    return reply({ text: `🎤 Voice bhej diya.` });
  }
  if (cmd === 'tts') {
    const t = args.join(' ');
    if (!t) return reply({ text: '❌ Text do.' });
    return sendVoice(sock, from, t);
  }
  if (cmd === 'qr') {
    const t = args.join(' ');
    if (!t) return reply({ text: '❌ Text do.' });
    const buffer = await qrcode.toBuffer(t, { width: 512 });
    return sendImage(buffer, `QR: ${t}`);
  }
  if (cmd === 'translate' || cmd === 'trt') {
    const lang = args[0];
    const t = args.slice(1).join(' ');
    if (!lang || !t) return reply({ text: '❌ .translate <lang> <text>' });
    const out = await translate(t, { to: lang });
    return reply({ text: `🌐 ${out}` });
  }

  // DECODE
  if (cmd === 'decode' || cmd === 'dec') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ Example: ${P}decode <text>` });
    return reply({ text: `🔓 *Decoded:*\n\n${smartDecode(input)}` });
  }
  if (cmd === 'encode' || cmd === 'enc') {
    const type = args[0]?.toLowerCase();
    const input = args.slice(1).join(' ');
    if (!type || !input) return reply({ text:
`❌ ${P}encode base64 <text>
${P}encode hex <text>
${P}encode url <text>
${P}encode binary <text>
${P}encode rot13 <text>` });
    let out = '';
    try {
      if (type === 'base64' || type === 'b64') out = Buffer.from(input).toString('base64');
      else if (type === 'hex') out = Buffer.from(input).toString('hex');
      else if (type === 'url') out = encodeURIComponent(input);
      else if (type === 'binary' || type === 'bin') out = input.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
      else if (type === 'rot13') out = input.replace(/[a-zA-Z]/g, c => String.fromCharCode((c <= 'Z' ? 90 : 122) >= (c = c.charCodeAt(0) + 13) ? c : c - 26));
      else return reply({ text: '❌ Type: base64, hex, url, binary, rot13' });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
    return reply({ text: `🔐 *Encoded (${type}):*\n\n${out}` });
  }
  if (cmd === 'hash') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ ${P}hash <text>` });
    const crypto = await import('crypto');
    const md5 = crypto.createHash('md5').update(input).digest('hex');
    const sha1 = crypto.createHash('sha1').update(input).digest('hex');
    const sha256 = crypto.createHash('sha256').update(input).digest('hex');
    return reply({ text: `🔒 *Hashes*\n\nMD5: ${md5}\nSHA1: ${sha1}\nSHA256: ${sha256}` });
  }
  if (cmd === 'jwt') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ ${P}jwt <token>` });
    try {
      const parts = input.split('.');
      const header = JSON.parse(Buffer.from(parts[0], 'base64').toString());
      const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());
      return reply({ text: `🔓 *JWT*\n\nHeader:\n${JSON.stringify(header, null, 2)}\n\nPayload:\n${JSON.stringify(payload, null, 2)}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'bin' || cmd === 'binary') {
    const input = args.join(' ');
    if (!input) return reply({ text: `❌ ${P}bin 01001000 01101001` });
    try {
      if (/^[01\s]+$/.test(input)) {
        const out = input.trim().split(/\s+/).map(b => String.fromCharCode(parseInt(b, 2))).join('');
        return reply({ text: `🔓 Binary decoded:\n${out}` });
      }
      const out = input.split('').map(c => c.charCodeAt(0).toString(2).padStart(8, '0')).join(' ');
      return reply({ text: `🔐 Binary:\n${out}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }

  // DOWNLOADERS
  if (cmd === 'ytmp3' || cmd === 'play' || cmd === 'song') {
    const q = args.join(' ');
    if (!q) return reply({ text: '❌ Gaana ka naam ya link do.' });
    try {
      let url = q;
      if (!/^https?:\/\//.test(q)) {
        const r = await yts(q);
        if (!r.videos[0]) return reply({ text: '❌ Nahi mila.' });
        url = r.videos[0].url;
      }
      await reply({ text: `🎵 Download...` });
      const { url: dlUrl, title } = await dlYouTube(url, 'audio');
      return sock.sendMessage(from, { audio: { url: dlUrl }, mimetype: 'audio/mp4', fileName: `${title}.mp3` }, { noSelfSync: true });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'ytmp4' || cmd === 'video' || cmd === 'yt') {
    const q = args.join(' ');
    if (!q) return reply({ text: '❌ Video ka naam ya link do.' });
    try {
      let url = q;
      if (!/^https?:\/\//.test(q)) {
        const r = await yts(q);
        if (!r.videos[0]) return reply({ text: '❌ Nahi mila.' });
        url = r.videos[0].url;
      }
      await reply({ text: `🎬 Download...` });
      const { url: dlUrl, title } = await dlYouTube(url, 'video');
      return sock.sendMessage(from, { video: { url: dlUrl }, mimetype: 'video/mp4', caption: title }, { noSelfSync: true });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'tiktok' || cmd === 'tt') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}tiktok <link>` });
    try {
      await reply({ text: '⏳ TikTok...' });
      const { video, title, author } = await dlTikTok(url);
      return sock.sendMessage(from, {
        video: { url: video },
        caption: `🎵 ${title}${author ? '\n👤 ' + author : ''}\n📥 HD — BAZZ MD`
      }, { noSelfSync: true });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'instagram' || cmd === 'ig' || cmd === 'insta') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}ig <link>` });
    try {
      await reply({ text: '⏳ Instagram...' });
      const r = await dlInstagram(url);
      if (r.video) return sock.sendMessage(from, { video: { url: r.video }, caption: `📸 Instagram` }, { noSelfSync: true });
      if (r.image) return sock.sendMessage(from, { image: { url: r.image }, caption: `📸 Instagram` }, { noSelfSync: true });
      return reply({ text: '❌ Nahi mila.' });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'facebook' || cmd === 'fb') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}fb <link>` });
    try {
      await reply({ text: '⏳ Facebook...' });
      const { video, title } = await dlFacebook(url);
      return sock.sendMessage(from, { video: { url: video }, caption: `📘 ${title}` }, { noSelfSync: true });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'twitter' || cmd === 'tw' || cmd === 'x') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}tw <link>` });
    try {
      await reply({ text: '⏳ Twitter...' });
      const { video, title } = await dlTwitter(url);
      return sock.sendMessage(from, { video: { url: video }, caption: `🐦 ${title}` }, { noSelfSync: true });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'pinterest' || cmd === 'pin') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}pin <link>` });
    try {
      await reply({ text: '⏳ Pinterest...' });
      const r = await dlPinterest(url);
      if (r.video) return sock.sendMessage(from, { video: { url: r.video }, caption: `📌 Pinterest` }, { noSelfSync: true });
      if (r.image) return sock.sendMessage(from, { image: { url: r.image }, caption: `📌 Pinterest` }, { noSelfSync: true });
      return reply({ text: '❌ Nahi mila.' });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'reddit' || cmd === 'rd') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}reddit <link>` });
    try {
      const clean = url.split('?')[0].replace(/\/$/, '');
      const { data } = await http.get(`${clean}.json`, { headers: { 'User-Agent': 'Mozilla/5.0 BAZZ' } });
      const post = data[0]?.data?.children?.[0]?.data;
      if (!post) return reply({ text: '❌ Fail.' });
      const media = post.url_overridden_by_dest || post.url;
      if (/\.(jpg|jpeg|png|gif)$/i.test(media)) return sock.sendMessage(from, { image: { url: media }, caption: `👽 ${post.title}` }, { noSelfSync: true });
      if (post.is_video) {
        const vid = post.media?.reddit_video?.fallback_url || media;
        return sock.sendMessage(from, { video: { url: vid }, caption: `👽 ${post.title}` }, { noSelfSync: true });
      }
      return reply({ text: `👽 ${post.title}\n🔗 ${media}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }

  // PAKSIM INFO — multi fallback
  if (cmd === 'paksiminfo' || cmd === 'paksim' || cmd === 'siminfo' || cmd === 'sim') {
    const query = args[0];
    if (!query) return reply({ text: `❌ ${P}paksiminfo <num/cnic>` });
    const cleaned = query.replace(/[^\d]/g, '');
    if (cleaned.length < 11) return reply({ text: '❌ Min 11 digit.' });
    await reply({ text: `🔍 Search: ${cleaned}...` });
    const nex = config.nexoracle;
    const endpoints = [
      { name: 'NexOracle (paid)', url: `${nex.paid}?key=${nex.paidKey}&num=${cleaned}` },
      { name: 'NexOracle (free)', url: `${nex.free}?key=${nex.freeKey}&num=${cleaned}` },
      { name: 'ElevateX', url: `${config.paksimApi}?num=${cleaned}` }
    ];
    let success = null;
    for (const ep of endpoints) {
      try {
        const { data } = await http.get(ep.url, { validateStatus: () => true, timeout: 20000 });
        const records = data?.records || data?.result?.records || data?.data?.records || data?.result || data?.data;
        if (data?.success === false || data?.status === false) continue;
        if (!records) continue;
        let list = [];
        if (Array.isArray(records)) list = records;
        else if (typeof records === 'object') list = [records];
        if (!list.length) continue;
        success = { source: ep.name, list };
        break;
      } catch { continue; }
    }
    if (!success) return reply({ text: `❌ Koi API data nahi de rahi.` });
    let out = `╭━━「 *PAKSIM INFO* 」━━\n│\n│ 📊 Records: ${success.list.length}\n│ 🔍 Query: ${cleaned}\n│ 📡 Source: ${success.source}\n│\n`;
    success.list.forEach((r, i) => {
      out += `├━━「 *Record ${i + 1}* 」\n`;
      const name = r.name || r.full_name || r.fullName;
      const mobile = r.mobile || r.number || r.phone || r.msisdn;
      const cnic = r.cnic || r.id_card || r.cnic_number;
      const network = r.network || r.operator || r.sim;
      const address = r.address || r.full_address || r.location;
      const province = r.province || r.region;
      if (name) out += `│ 👤 ${name}\n`;
      if (mobile) out += `│ 📱 ${mobile}\n`;
      if (cnic) out += `│ 🆔 ${cnic}\n`;
      if (network) out += `│ 📡 ${network}\n`;
      if (province) out += `│ 🌍 ${province}\n`;
      if (address) out += `│ 🏠 ${address}\n`;
      out += `│\n`;
    });
    out += `╰━━「 *${config.botName}* 」`;
    return reply({ text: out });
  }

  // EXTRAS
  if (cmd === 'weather' || cmd === 'w') {
    const city = args.join(' ');
    if (!city) return reply({ text: `❌ ${P}weather Karachi` });
    try {
      const { data } = await http.get(`https://wttr.in/${encodeURIComponent(city)}?format=j1`);
      const cur = data.current_condition[0];
      const area = data.nearest_area[0];
      return reply({ text: `🌤 *${area.areaName[0].value}, ${area.country[0].value}*\n\n🌡 ${cur.temp_C}°C (feels ${cur.FeelsLikeC}°C)\n☁️ ${cur.weatherDesc[0].value}\n💧 ${cur.humidity}%\n💨 ${cur.windspeedKmph} km/h` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'lyrics' || cmd === 'ly') {
    const q = args.join(' ');
    if (!q) return reply({ text: `❌ ${P}lyrics Tum Hi Ho` });
    try {
      const { data } = await http.get(`https://api.lyrics.ovh/suggest/${encodeURIComponent(q)}`);
      if (!data?.data?.length) return reply({ text: '❌ Nahi mila.' });
      const top = data.data[0];
      const { data: ly } = await http.get(`https://api.lyrics.ovh/v1/${encodeURIComponent(top.artist.name)}/${encodeURIComponent(top.title)}`);
      return reply({ text: `🎵 *${top.title}*\n👤 ${top.artist.name}\n\n${(ly.lyrics || '').slice(0, 3000)}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'shorturl' || cmd === 'short') {
    const url = args[0];
    if (!url || !/^https?:\/\//.test(url)) return reply({ text: `❌ ${P}short <url>` });
    try {
      const { data } = await http.get(`https://tinyurl.com/api-create.php?url=${encodeURIComponent(url)}`);
      return reply({ text: `🔗 ${data}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'ss' || cmd === 'screenshot') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}ss <url>` });
    const fullUrl = /^https?:\/\//.test(url) ? url : `https://${url}`;
    try {
      await reply({ text: '📸 Screenshot...' });
      const imgUrl = `https://api.microlink.io/?url=${encodeURIComponent(fullUrl)}&screenshot=true&meta=false&embed=screenshot.url`;
      return sock.sendMessage(from, { image: { url: imgUrl }, caption: `📸 ${fullUrl}` }, { noSelfSync: true });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'ip') {
    const ip = args[0];
    if (!ip) return reply({ text: `❌ ${P}ip 8.8.8.8` });
    try {
      const { data } = await http.get(`http://ip-api.com/json/${ip}`);
      if (data.status !== 'success') return reply({ text: '❌ Invalid.' });
      return reply({ text: `🌐 *IP*\n\nIP: ${data.query}\n🌍 ${data.country}\n🏙 ${data.city}\n📍 ${data.regionName}\n🏢 ${data.isp}\n🕒 ${data.timezone}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'myip') {
    try {
      const { data } = await http.get('http://ip-api.com/json/');
      return reply({ text: `🌐 Server IP: ${data.query}\n🌍 ${data.country} — ${data.city}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'calc' || cmd === 'math') {
    const expr = args.join(' ');
    if (!expr) return reply({ text: `❌ ${P}calc 2+2*3` });
    if (!/^[0-9+\-*/().\s%^]+$/.test(expr)) return reply({ text: '❌ Sirf numbers + - * / ( )' });
    try {
      const result = Function('"use strict";return (' + expr + ')')();
      return reply({ text: `🧮 ${expr} = *${result}*` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'uptime' || cmd === 'up') {
    const up = process.uptime();
    const d = Math.floor(up / 86400);
    const h = Math.floor((up % 86400) / 3600);
    const m = Math.floor((up % 3600) / 60);
    return reply({ text: `⏱ ${d}d ${h}h ${m}m` });
  }
  if (cmd === 'pass' || cmd === 'password') {
    const len = parseInt(args[0]) || 16;
    if (len < 4 || len > 64) return reply({ text: '❌ 4-64.' });
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let pass = '';
    for (let i = 0; i < len; i++) pass += chars[Math.floor(Math.random() * chars.length)];
    return reply({ text: `🔐 \`${pass}\`` });
  }
  if (cmd === 'uuid') {
    const crypto = await import('crypto');
    return reply({ text: `🆔 \`${crypto.randomUUID()}\`` });
  }

  // DARK / OSINT
  if (cmd === 'user' || cmd === 'username') {
    const name = args[0];
    if (!name) return reply({ text: `❌ ${P}user bazz` });
    await reply({ text: `🔍 @${name}...` });
    const sites = [
      ['GitHub', `https://github.com/${name}`],
      ['Twitter', `https://twitter.com/${name}`],
      ['Instagram', `https://instagram.com/${name}`],
      ['TikTok', `https://tiktok.com/@${name}`],
      ['Reddit', `https://reddit.com/user/${name}`],
      ['Telegram', `https://t.me/${name}`],
      ['YouTube', `https://youtube.com/@${name}`],
      ['Pinterest', `https://pinterest.com/${name}`],
      ['Twitch', `https://twitch.tv/${name}`],
      ['Medium', `https://medium.com/@${name}`],
      ['Keybase', `https://keybase.io/${name}`],
      ['Steam', `https://steamcommunity.com/id/${name}`]
    ];
    const found = [];
    await Promise.all(sites.map(async ([label, url]) => {
      try {
        const r = await http.head(url, { timeout: 5000, validateStatus: () => true, maxRedirects: 0 });
        if (r.status >= 200 && r.status < 400) found.push(`✅ ${label}: ${url}`);
      } catch {}
    }));
    if (!found.length) return reply({ text: `❌ @${name} kahin nahi.` });
    return reply({ text: `🔍 @${name}:\n\n${found.join('\n')}` });
  }
  if (cmd === 'geo' || cmd === 'whereis') {
    const ip = args[0];
    if (!ip) return reply({ text: `❌ ${P}geo 8.8.8.8` });
    try {
      const { data } = await http.get(`http://ip-api.com/json/${ip}?fields=status,country,regionName,city,zip,lat,lon,timezone,isp,org,as,query`);
      if (data.status !== 'success') return reply({ text: '❌ Invalid.' });
      return reply({ text: `📍 *${data.query}*\n\n🌍 ${data.country} — ${data.regionName} — ${data.city}\n🧭 ${data.lat}, ${data.lon}\n🗺 https://maps.google.com/?q=${data.lat},${data.lon}\n🏢 ${data.isp}\n📡 ${data.as}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'whois') {
    const dom = args[0]?.replace(/^https?:\/\//, '').split('/')[0];
    if (!dom) return reply({ text: `❌ ${P}whois google.com` });
    try {
      const { data } = await http.get(`https://rdap.org/domain/${dom}`);
      return reply({ text: `🌐 *WHOIS ${dom}*\n\nStatus: ${(data.status || []).join(', ') || '-'}\nEvents:\n${(data.events || []).map(e => `• ${e.eventAction}: ${e.eventDate}`).join('\n')}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'dns') {
    const dom = args[0];
    if (!dom) return reply({ text: `❌ ${P}dns google.com` });
    try {
      const { data } = await http.get(`https://dns.google/resolve?name=${dom}&type=A`);
      const { data: mx } = await http.get(`https://dns.google/resolve?name=${dom}&type=MX`);
      const a = (data.Answer || []).map(x => `A: ${x.data}`).join('\n');
      const m = (mx.Answer || []).map(x => `MX: ${x.data}`).join('\n');
      return reply({ text: `🌐 *DNS ${dom}*\n\n${a}\n${m}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'port') {
    const host = args[0];
    if (!host) return reply({ text: `❌ ${P}port scanme.nmap.org` });
    const net = await import('net');
    const ports = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 3306, 3389, 5432, 8080, 8443];
    await reply({ text: `🔍 ${host}...` });
    const results = [];
    await Promise.all(ports.map(p => new Promise(res => {
      const s = new net.Socket();
      s.setTimeout(3000);
      s.on('connect', () => { results.push(`✅ ${p}`); s.destroy(); res(); });
      s.on('timeout', () => { s.destroy(); res(); });
      s.on('error', () => { res(); });
      s.connect(p, host);
    })));
    if (!results.length) return reply({ text: `❌ Koi port open nahi.` });
    return reply({ text: `🔓 *Open on ${host}*\n\n${results.sort().join('\n')}` });
  }
  if (cmd === 'headers' || cmd === 'head') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}headers <url>` });
    const fullUrl = /^https?:\/\//.test(url) ? url : `https://${url}`;
    try {
      const { headers } = await http.head(fullUrl, { validateStatus: () => true });
      const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\n');
      return reply({ text: `🌐 *${fullUrl}*\n\n${lines.slice(0, 2000)}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'ssl') {
    const host = args[0]?.replace(/^https?:\/\//, '').split('/')[0];
    if (!host) return reply({ text: `❌ ${P}ssl google.com` });
    try {
      const tls = await import('tls');
      const info = await new Promise((resolve, reject) => {
        const s = tls.connect(443, host, { servername: host, rejectUnauthorized: false }, () => {
          const cert = s.getPeerCertificate();
          s.end();
          resolve(cert);
        });
        s.on('error', reject);
      });
      return reply({ text: `🔒 *${host}*\n\nSubject: ${info.subject?.CN || '-'}\nIssuer: ${info.issuer?.O || '-'}\nFrom: ${info.valid_from}\nTo: ${info.valid_to}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'wayback' || cmd === 'archive') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}wayback google.com` });
    try {
      const { data } = await http.get(`https://archive.org/wayback/available?url=${encodeURIComponent(url)}`);
      if (!data.archived_snapshots?.closest) return reply({ text: '❌ Snapshot nahi.' });
      const s = data.archived_snapshots.closest;
      return reply({ text: `📚 ${url}\n\n🕒 ${s.timestamp}\n🔗 ${s.url}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'paste') {
    const t = args.join(' ');
    if (!t) return reply({ text: `❌ ${P}paste <text>` });
    try {
      const { data } = await http.post('https://paste.rs/', t, { headers: { 'Content-Type': 'text/plain' } });
      return reply({ text: `📋 ${data}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'unshort' || cmd === 'expand') {
    const url = args[0];
    if (!url) return reply({ text: `❌ ${P}unshort bit.ly/xxx` });
    try {
      const r = await http.get(url, { maxRedirects: 0, validateStatus: () => true });
      return reply({ text: `🔗 ${r.headers.location || url}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }

  // INFO APIs
  if (cmd === 'wiki' || cmd === 'wikipedia') {
    const q = args.join(' ');
    if (!q) return reply({ text: `❌ ${P}wiki Pakistan` });
    try {
      const { data } = await http.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(q)}`);
      if (!data.extract) return reply({ text: '❌ Nahi mila.' });
      return reply({ text: `📚 *${data.title}*\n\n${data.extract.slice(0, 1200)}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'define' || cmd === 'meaning') {
    const word = args[0];
    if (!word) return reply({ text: `❌ ${P}define hello` });
    try {
      const { data } = await http.get(`https://api.dictionaryapi.dev/api/v2/entries/en/${word}`);
      if (!Array.isArray(data) || !data[0]) return reply({ text: '❌ Nahi mila.' });
      const m = data[0].meanings[0];
      return reply({ text: `📖 *${data[0].word}*\n\n_${m.partOfSpeech}_\n\n${m.definitions[0].definition}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'convert' || cmd === 'rate') {
    const [amt, from, to] = args;
    if (!amt || !from || !to) return reply({ text: `❌ ${P}convert 100 USD PKR` });
    try {
      const { data } = await http.get(`https://api.exchangerate-api.com/v4/latest/${from.toUpperCase()}`);
      const rate = data.rates[to.toUpperCase()];
      if (!rate) return reply({ text: '❌ Currency nahi.' });
      return reply({ text: `💱 ${amt} ${from.toUpperCase()} = *${(parseFloat(amt) * rate).toFixed(2)} ${to.toUpperCase()}*` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'crypto' || cmd === 'btc') {
    const coin = args[0]?.toLowerCase() || 'bitcoin';
    try {
      const { data } = await http.get(`https://api.coingecko.com/api/v3/simple/price?ids=${coin}&vs_currencies=usd,pkr&include_24hr_change=true`);
      const c = data[coin];
      if (!c) return reply({ text: '❌ Coin nahi.' });
      return reply({ text: `💰 *${coin.toUpperCase()}*\n\n💵 $${c.usd}\n🇵🇰 ₨${c.pkr}\n📈 ${c.usd_24h_change?.toFixed(2)}%` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'namaz' || cmd === 'prayer') {
    const city = args.join(' ') || 'Karachi';
    try {
      const { data } = await http.get(`https://api.aladhan.com/v1/timingsByCity?city=${encodeURIComponent(city)}&country=PK&method=1`);
      const t = data.data.timings;
      return reply({ text: `🕌 *${city}*\n\n🌅 Fajr: ${t.Fajr}\n☀️ Dhuhr: ${t.Dhuhr}\n🌤 Asr: ${t.Asr}\n🌇 Maghrib: ${t.Maghrib}\n🌙 Isha: ${t.Isha}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'quran' || cmd === 'ayah') {
    const num = args[0] || Math.floor(Math.random() * 6236) + 1;
    try {
      const { data } = await http.get(`https://api.alquran.cloud/v1/ayah/${num}/editions/ar.asad,en.sahih`);
      const ar = data.data[0];
      const en = data.data[1];
      return reply({ text: `📖 *${ar.surah.englishName} — ${ar.numberInSurah}*\n\n${ar.text}\n\n_${en.text}_` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'npm') {
    const pkg = args[0];
    if (!pkg) return reply({ text: `❌ ${P}npm axios` });
    try {
      const { data } = await http.get(`https://registry.npmjs.org/${pkg}`);
      return reply({ text: `📦 *${data.name}*\n\n${data.description || '-'}\n🏷 ${data['dist-tags']?.latest}\n🔗 npmjs.com/package/${data.name}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'ghuser') {
    const user = args[0];
    if (!user) return reply({ text: `❌ ${P}ghuser torvalds` });
    try {
      const { data } = await http.get(`https://api.github.com/users/${user}`);
      if (data.message) return reply({ text: '❌ Nahi mila.' });
      return reply({ text: `🐙 *${data.login}*\n\n👤 ${data.name || '-'}\n📝 ${data.bio || '-'}\n👥 ${data.followers}\n⭐ ${data.public_repos}\n🔗 ${data.html_url}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'github' || cmd === 'gh') {
    const q = args.join(' ');
    if (!q) return reply({ text: `❌ ${P}github baileys` });
    try {
      const { data } = await http.get(`https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&per_page=1`);
      if (!data.items?.length) return reply({ text: '❌ Nahi mila.' });
      const r = data.items[0];
      return reply({ text: `🐙 *${r.full_name}*\n\n${r.description || '-'}\n⭐ ${r.stargazers_count}\n🍴 ${r.forks_count}\n🔗 ${r.html_url}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'cve') {
    const id = args[0]?.toUpperCase();
    if (!id) return reply({ text: `❌ ${P}cve CVE-2021-44228` });
    try {
      const { data } = await http.get(`https://cve.circl.lu/api/cve/${id}`);
      if (!data) return reply({ text: '❌ Nahi mila.' });
      return reply({ text: `🛡 *${data.id}*\n\n📅 ${data.Published}\n⚠️ CVSS: ${data.cvss || '-'}\n\n${(data.summary || '').slice(0, 800)}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'trending' || cmd === 'trend') {
    try {
      const { data } = await http.get('https://api.github.com/search/repositories?q=created:>2024-01-01&sort=stars&order=desc&per_page=5');
      const list = data.items.map((r, i) => `${i + 1}. *${r.full_name}* ⭐${r.stargazers_count}\n   ${r.description || ''}`).join('\n\n');
      return reply({ text: `🔥 *GitHub Trending*\n\n${list}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }
  if (cmd === 'yts' || cmd === 'ytsearch') {
    const q = args.join(' ');
    if (!q) return reply({ text: `❌ ${P}yts Tum Hi Ho` });
    try {
      const r = await yts(q);
      const list = r.videos.slice(0, 5).map((v, i) => `${i + 1}. *${v.title}*\n   ⏱ ${v.timestamp} · 👤 ${v.author.name}\n   ${v.url}`).join('\n\n');
      return reply({ text: `🔍 *${q}*\n\n${list}` });
    } catch (e) { return reply({ text: `❌ ${e.message}` }); }
  }

  // GROUP
  if (isGroup && cmd === 'tagall') {
    const meta = await sock.groupMetadata(from);
    const mentions = meta.participants.map(p => p.id);
    const t = args.join(' ') || 'Attention!';
    return sock.sendMessage(from, { text: `📢 ${t}\n\n${mentions.map(m => `@${m.split('@')[0]}`).join('\n')}`, mentions }, { noSelfSync: true });
  }
  if (isGroup && cmd === 'kick') {
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned) return reply({ text: '❌ Mention karo.' });
    await sock.groupParticipantsUpdate(from, mentioned, 'remove');
    return reply({ text: '✅' });
  }
  if (isGroup && cmd === 'promote') {
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned) return reply({ text: '❌ Mention karo.' });
    await sock.groupParticipantsUpdate(from, mentioned, 'promote');
    return reply({ text: '✅' });
  }
  if (isGroup && cmd === 'demote') {
    const mentioned = msg.message.extendedTextMessage?.contextInfo?.mentionedJid;
    if (!mentioned) return reply({ text: '❌ Mention karo.' });
    await sock.groupParticipantsUpdate(from, mentioned, 'demote');
    return reply({ text: '✅' });
  }
  if (isGroup && cmd === 'groupinfo') {
    const meta = await sock.groupMetadata(from);
    return reply({ text: `📊 ${meta.subject}\n👥 ${meta.participants.length}\n👑 ${meta.participants.filter(p => p.admin).length}\n🆔 ${from}` });
  }

  // FUN
  if (cmd === 'joke') {
    const jokes = ['Teacher: Homework kahan hai? Me: Sir WiFi down tha.', 'Doctor: Kya takleef? Me: Log samajh nahi paate.', 'Body me 70% pani, 30% chai.'];
    return reply({ text: jokes[Math.floor(Math.random() * jokes.length)] });
  }
  if (cmd === 'quote') {
    const quotes = ['Jo jeeta wohi Sikandar.', 'Koshish karne walon ki haar nahi hoti.', 'Waqt se pehle aur naseeb se zyada kisi ko kuch nahi milta.'];
    return reply({ text: quotes[Math.floor(Math.random() * quotes.length)] });
  }
  if (cmd === 'dice') return reply({ text: `🎲 ${Math.floor(Math.random() * 6) + 1}` });
  if (cmd === 'coin') return reply({ text: `🪙 ${Math.random() < 0.5 ? 'HEADS' : 'TAILS'}` });
  if (cmd === 'rand' || cmd === 'random') {
    const max = parseInt(args[0]) || 100;
    return reply({ text: `🎲 ${Math.floor(Math.random() * max) + 1}` });
  }
  if (cmd === 'riddle') {
    const riddles = ['Din me 2 baar, raat me 0. Kya? → *A*', 'Jitna kheecho, utna chhota. Kya? → *Cigarette*', 'Bina khaye marta nahi, bina piye jee nahi sakta. Kya? → *Aag*'];
    return reply({ text: `🧩 ${riddles[Math.floor(Math.random() * riddles.length)]}` });
  }
  if (cmd === 'fact') {
    const facts = ['Octopus ke 3 dil hote hain.', 'Honey kabhi kharab nahi hota.', 'Bananas radioactive hote hain.'];
    return reply({ text: `💡 ${facts[Math.floor(Math.random() * facts.length)]}` });
  }
  if (cmd === 'shayari' || cmd === 'shayri') {
    const lines = ['Dil ki baat labon pe na laao,\nWaqt ka kya hai, badal jaaye.', 'Tumhari yaad me hum jeete hain,\nTumhare bina hum marte hain.', 'Chand ko dekha, tujhe yaad kiya,\nDua me tujhe har baar maanga.'];
    return reply({ text: `💌 ${lines[Math.floor(Math.random() * lines.length)]}` });
  }
  if (cmd === 'fake' || cmd === 'anon') {
    const first = ['Ali','Hassan','Ahmed','Bilal','Usman','Zain','Hamza','Saad','Faisal','Tariq'];
    const last = ['Khan','Ahmed','Ali','Malik','Sheikh','Butt','Chaudhry','Raza'];
    const cities = ['Karachi','Lahore','Islamabad','Rawalpindi','Faisalabad','Multan','Peshawar','Quetta'];
    const fn = first[Math.floor(Math.random() * first.length)];
    const ln = last[Math.floor(Math.random() * last.length)];
    const city = cities[Math.floor(Math.random() * cities.length)];
    return reply({ text: `🎭 *Fake*\n\n${fn} ${ln}\n${city}\n${fn.toLowerCase()}.${ln.toLowerCase()}${Math.floor(Math.random() * 100)}@gmail.com\n+92 3${Math.floor(Math.random() * 5)}${Math.floor(Math.random() * 10000000).toString().padStart(7, '0')}` });
  }
}

export async function handleCall(sock, calls) {
  if (!antiCall.enabled) return;
  for (const call of calls) {
    if (call.status === 'offer') {
      await sock.rejectCall(call.id, call.from).catch(() => {});
      await sock.sendMessage(call.from, { text: '📵 Calls allowed nahi. Message karo.' }, { noSelfSync: true }).catch(() => {});
    }
  }
}

function buildMenu(name) {
  return `╭━━━「 *${config.botName}* 」━━━
│
│ 👋 ${name}
│ 👑 ${config.ownerName}
│
├━━「 *MAIN* 」
│ ${P}menu · ${P}ping · ${P}owner
│ ${P}info · ${P}time
│
├━━「 *AI* 」
│ ${P}jaan · ${P}gf · ${P}dost
│ ${P}teacher · ${P}philosopher
│ ${P}ai <q>
│
├━━「 *TOOLS* 」
│ ${P}sticker · ${P}toimg · ${P}vv
│ ${P}aivoice · ${P}tts
│ ${P}qr · ${P}translate
│ ${P}decode · ${P}encode · ${P}hash
│ ${P}jwt · ${P}bin
│
├━━「 *DOWNLOAD* 」
│ ${P}ytmp3 · ${P}ytmp4
│ ${P}tiktok · ${P}ig · ${P}fb
│ ${P}tw · ${P}pin · ${P}reddit
│
├━━「 *PAKSIM* 」
│ ${P}paksiminfo <num/cnic>
│
├━━「 *OSINT* 」
│ ${P}user · ${P}geo · ${P}whois
│ ${P}dns · ${P}port · ${P}headers
│ ${P}ssl · ${P}wayback · ${P}unshort
│ ${P}paste
│
├━━「 *INFO* 」
│ ${P}wiki · ${P}define · ${P}yts
│ ${P}convert · ${P}crypto
│ ${P}namaz · ${P}quran
│ ${P}npm · ${P}github · ${P}ghuser
│ ${P}cve · ${P}trending
│ ${P}weather · ${P}lyrics · ${P}ss
│ ${P}shorturl · ${P}ip · ${P}myip
│ ${P}calc · ${P}uptime
│ ${P}pass · ${P}uuid
│
├━━「 *GROUP GUARD* 」
│ ${P}antilink · ${P}antispam
│ ${P}antitoxic · ${P}antidelete
│ ${P}welcome · ${P}bye
│ ${P}autoreact · ${P}anticall
│
├━━「 *GROUP* 」
│ ${P}tagall · ${P}kick
│ ${P}promote · ${P}demote
│ ${P}groupinfo
│
├━━「 *OWNER* 」
│ ${P}spam <text> <count>
│
├━━「 *FUN* 」
│ ${P}joke · ${P}quote · ${P}dice
│ ${P}coin · ${P}rand · ${P}riddle
│ ${P}fact · ${P}shayari · ${P}fake
│
╰━━「 *${config.botName}* 」`;
}
