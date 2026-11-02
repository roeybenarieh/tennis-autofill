const test = require("node:test");
const assert = require("node:assert/strict");
const { DisconnectReason } = require("@whiskeysockets/baileys");
const { formEntry, recordMessages, reconnectDelay, findFormLink } = require("./whatsapp");

test("solo-group links, wrapped messages, history filtering and deduplication", () => {
  const group = "123@g.us";
  const now = 1_800_000_000_000;
  const link = "https://docs.google.com/forms/d/e/test/viewform";
  const msg = {
    key: { remoteJid: group, id: "one", fromMe: true },
    messageTimestamp: now / 1000,
    message: { ephemeralMessage: { message: { extendedTextMessage: { text: `(${link}).` } } } },
  };
  assert.equal(formEntry(msg, group, now).link, link);
  assert.equal(formEntry(msg, group, now).fromMe, true);
  assert.equal(formEntry(msg, "456@g.us", now), null);
  assert.equal(formEntry({ ...msg, messageTimestamp: now / 1000 - 40 * 3600 - 1 }, group, now), null);
  assert.equal(formEntry({ ...msg, messageTimestamp: undefined }, group, now), null);
  assert.equal(formEntry({ ...msg, messageTimestamp: now / 1000 + 61 }, group, now), null);
  assert.equal(formEntry({ ...msg, message: { imageMessage: { caption: link } } }, group, now).link, link);
  for (const bad of ["https://docs.google.com.evil/forms/x", "https://docs.google.com/forms.evil/x", "https://evil@docs.google.com/forms/x", "https://docs.google.com:444/forms/x"]) {
    assert.equal(findFormLink(bad), null);
  }
  const entries = new Map();
  assert.equal(recordMessages([msg, msg], group, entries, now).length, 1);
  // Same message redelivered after restarting with a saved cache is ignored.
  const restored = new Map(JSON.parse(JSON.stringify([...entries])));
  assert.equal(recordMessages([msg], group, restored, now).length, 0);
  recordMessages([], group, restored, now + 40 * 3600 * 1000 + 1);
  assert.equal(restored.size, 0);
});

test("pairing restart and transient close override antiban classifications", () => {
  assert.equal(reconnectDelay(DisconnectReason.restartRequired, 0), 1000);
  assert.equal(reconnectDelay(DisconnectReason.connectionClosed, 0), 10000);
  assert.equal(reconnectDelay(DisconnectReason.loggedOut, 0), null);
  assert.equal(reconnectDelay(DisconnectReason.connectionReplaced, 0), null);
  assert.equal(reconnectDelay(429, 0), 300000);
  assert.equal(reconnectDelay(408, 100), 600000);
});
