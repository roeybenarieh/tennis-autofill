// Passive WhatsApp listener (Baileys): receives messages from one group, caches recent Google Form
// links, and reports new ones. It sends no messages, typing indicators or read receipts.
const fs = require("node:fs");
const path = require("node:path");
const { default: makeWASocket, DisconnectReason, useMultiFileAuthState,
  normalizeMessageContent } = require("@whiskeysockets/baileys");
const { classifyDisconnect } = require("baileys-antiban");
const { keepAlive } = require("baileys-keep-alive");
const pino = require("pino");

const WINDOW_MS = 40 * 3600 * 1000;

// Known harmless Baileys logs, dropped before they reach stderr. Anything else still logs.
// - direct-chat messages we can't decrypt (session counter out of sync; never the watched group)
// - contact status updates Baileys misroutes to its newsletter handler
function isKnownNoise(args) {
  const [obj, msg] = args;
  if (msg === "failed to decrypt message" && obj?.err?.name === "MessageCounterError"
    && !String(obj.key?.remoteJid).endsWith("@g.us")) return true;
  return msg === "Invalid mex newsletter notification";
}

// The QR is a login credential: private file, replaced atomically, refreshed by the page.
async function writeQrHtml(file, qr) {
  // loaded on demand: only needed while pairing, saves memory in the long-running service
  const image = await require("qrcode").toDataURL(qr, { width: 360, margin: 2 });
  const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="5">
<title>WhatsApp link</title><body style="font-family:sans-serif;text-align:center">
<h2>WhatsApp &gt; Linked devices &gt; Link a device</h2><img src="${image}" alt="QR code">
<p>This page refreshes itself; the code rotates every ~20 s.</p>`;
  fs.writeFileSync(`${file}.tmp`, html, { mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file);
}

// Reminds (via notify(waitedMs)) while a QR is shown but not scanned: after `afterMs`, then every
// `repeatMs`. The QR rotates every ~20 s, so the clock starts at the first one, not the latest.
function makeQrReminder({ afterMs, repeatMs, notify }) {
  let timer;
  let since;
  const schedule = (delay) => {
    timer = setTimeout(() => {
      notify(Date.now() - since);
      schedule(repeatMs);
    }, delay);
  };
  return {
    shown() {
      if (timer) return;
      since = Date.now();
      schedule(afterMs);
    },
    done() {
      clearTimeout(timer);
      timer = undefined;
    },
  };
}

function findFormLink(text) {
  for (const match of text.matchAll(/https:\/\/[^\s<>]+/g)) {
    const link = match[0].replace(/[.,!;)\]}]+$/, "");
    try {
      const url = new URL(link);
      if (url.hostname === "docs.google.com" && !url.port && !url.username && !url.password
          && url.pathname.startsWith("/forms/")) return link;
    } catch {}
  }
  return null;
}

function formEntry(msg, group, now = Date.now()) {
  if (msg.key?.remoteJid !== group || !msg.key.id) return null;
  const sent = Number(msg.messageTimestamp) * 1000;
  if (!Number.isFinite(sent) || sent < now - WINDOW_MS || sent > now + 60_000) return null;
  const content = normalizeMessageContent(msg.message) || {};
  const text = content.conversation || content.extendedTextMessage?.text
    || content.imageMessage?.caption || content.videoMessage?.caption || "";
  const link = findFormLink(text);
  if (!link) return null;
  return { group, idMessage: msg.key.id, link, sentAt: sent, fromMe: !!msg.key.fromMe };
}

function reconnectDelay(code, attempts) {
  // Baileys' own codes take precedence: antiban 4.10 misclassifies 515 and 428.
  if (code === DisconnectReason.restartRequired) return 1000;
  // 500 (badSession) is also Baileys' fallback for unknown stream errors: recoverable, so reconnect.
  if ([DisconnectReason.loggedOut, DisconnectReason.connectionReplaced,
    DisconnectReason.multideviceMismatch, 403, 405, 409].includes(code)) return null;
  return Math.max(classifyDisconnect(code).backoffMs || 0,
    Math.min(10_000 * 2 ** Math.min(attempts, 6), 600_000));
}

function recordMessages(messages, group, entries, now = Date.now()) {
  const added = [];
  for (const msg of messages) {
    const entry = formEntry(msg, group, now);
    if (!entry) continue;
    const key = `${entry.group}:${entry.idMessage}`;
    if (entries.has(key)) continue;
    entries.set(key, entry);
    added.push(entry);
  }
  for (const [key, entry] of entries) {
    if (entry.sentAt < now - WINDOW_MS) entries.delete(key);
  }
  return added;
}

function loadCache(dataDir, now = Date.now()) {
  const entries = new Map();
  const file = path.join(dataDir, "forms.json");
  if (fs.existsSync(file)) {
    for (const entry of JSON.parse(fs.readFileSync(file, "utf8"))) {
      if (entry.sentAt >= now - WINDOW_MS) entries.set(`${entry.group}:${entry.idMessage}`, entry);
    }
  }
  return entries;
}

// Connects (pairing via the QR file if needed) and keeps the connection alive. keepAlive owns
// reconnecting; fatal disconnects (logged out, replaced) call onFatal once. Returns { stop }.
async function startSocket({ dataDir, qrFile, onOpen, onMessages, onFatal, onQrUnscanned, log = console.error,
  qrRemindAfterMs = 60_000, qrRemindEveryMs = 600_000 }) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const { state, saveCreds } = await useMultiFileAuthState(path.join(dataDir, "auth"));
  const logger = pino({ level: "warn", hooks: { logMethod(args, method) { if (!isKnownNoise(args)) method.apply(this, args); } } },
    pino.destination(2));
  let attempts = 0;
  let lastCode;
  let socket;
  let keeper;
  let stopping = false;
  const qrReminder = makeQrReminder({
    afterMs: qrRemindAfterMs,
    repeatMs: qrRemindEveryMs,
    notify: (waitedMs) => {
      log(`QR still unscanned after ${Math.round(waitedMs / 1000)}s: ${qrFile}`);
      onQrUnscanned?.({ qrFile, waitedMs });
    },
  });

  function stop() {
    stopping = true;
    qrReminder.done();
    keeper?.stop();
    socket?.end(undefined);
    fs.rmSync(qrFile, { force: true });
  }
  function fail(error) {
    if (stopping) return;
    stop();
    onFatal(error);
  }

  function connect() {
    // fireInitQueries off: the props/blocklist/privacy queries are not needed to receive messages
    // and the props one times out ("unexpected error in 'init queries'").
    socket = makeWASocket({ auth: state, logger, markOnlineOnConnect: false, fireInitQueries: false });
    socket.ev.on("creds.update", () => saveCreds().catch(fail));
    socket.ev.on("messages.upsert", ({ messages }) => onMessages?.(messages));
    socket.ev.on("messaging-history.set", ({ messages }) => onMessages?.(messages));
    socket.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
      try {
        if (qr) {
          await writeQrHtml(qrFile, qr);
          log(`Open this file in a browser and scan it: ${qrFile}`);
          qrReminder.shown();
        }
        if (connection === "open") {
          attempts = 0;
          qrReminder.done();
          fs.rmSync(qrFile, { force: true });
          await onOpen?.(socket);
        }
        if (connection === "close" && !stopping) {
          // Runs before keepAlive's own close handler (registered later), so lastCode
          // and stop() are in place when it decides whether to reconnect.
          lastCode = lastDisconnect?.error?.output?.statusCode;
          if (reconnectDelay(lastCode, 0) === null) {
            fail(new Error(`Disconnected (${lastCode}); check linked devices/authentication before restarting.`));
          }
        }
      } catch (error) { fail(error); }
    });
    return socket;
  }

  // keepAlive owns reconnect and socket switching. Its backoff is zeroed because it resets
  // after every factory call (no growth), so the factory applies ours. Its presence
  // heartbeat is off: it would mark this account "available" and can suppress phone
  // notifications; the listener stays passive.
  keeper = keepAlive(connect(), {
    reconnect: { initialDelayMs: 0, jitterMs: 0 },
    heartbeat: { enabled: false },
    qr: { staleAfterMs: 2_147_483_647 }, // effectively off: makeQrReminder does this job

    logger: { info() {}, warn: log, error: log },
    reconnectFactory: async () => {
      if (stopping) throw new Error("stopped");
      const delay = reconnectDelay(lastCode, attempts++);
      log(`Disconnected (${lastCode}); reconnecting in ${delay / 1000}s.`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      if (stopping) throw new Error("stopped");
      return connect();
    },
  });
  return { stop };
}

// Watches `group`. Links sent before startup are cached only; onForm(entry) fires for new ones,
// including your own messages. Messages during a reconnect are caught by history sync.
async function watch({ dataDir, qrFile, group, onForm, onFatal, onQrUnscanned, log = console.error }) {
  const cacheFile = path.join(dataDir, "forms.json");
  const entries = loadCache(dataDir);
  const startedAt = Math.floor(Date.now() / 1000) * 1000;
  function receive(messages) {
    const added = recordMessages(messages, group, entries);
    if (!added.length) return;
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(`${cacheFile}.tmp`, JSON.stringify([...entries.values()]), { mode: 0o600 });
    fs.renameSync(`${cacheFile}.tmp`, cacheFile);
    for (const entry of added) if (entry.sentAt >= startedAt) onForm(entry);
  }
  return startSocket({
    dataDir, qrFile, onFatal, onQrUnscanned, log, onMessages: receive,
    onOpen: () => log(`Connected; watching ${group}. Pre-start links are only cached.`),
  });
}

// Prints id, name and member count of every group this account is in, then disconnects.
async function listGroups({ dataDir, qrFile, onFatal, onQrUnscanned, print = console.log }) {
  let session;
  session = await startSocket({
    dataDir, qrFile, onFatal, onQrUnscanned,
    onOpen: async (socket) => {
      for (const item of Object.values(await socket.groupFetchAllParticipating())) {
        print(JSON.stringify({ id: item.id, name: item.subject, participants: item.participants.length }));
      }
      session.stop();
    },
  });
}

module.exports = { makeQrReminder, findFormLink, formEntry, recordMessages, reconnectDelay, loadCache, isKnownNoise, watch, listGroups };
