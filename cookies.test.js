const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { cookieHeader, decryptValue, V10_KEY } = require("./cookies");

function encrypt(value, hostKey, withHostHash) {
  const cipher = crypto.createCipheriv("aes-128-cbc", V10_KEY, Buffer.alloc(16, " "));
  const plain = Buffer.concat([withHostHash ? crypto.createHash("sha256").update(hostKey).digest() : Buffer.alloc(0), Buffer.from(value)]);
  return Buffer.concat([Buffer.from("v10"), cipher.update(plain), cipher.final()]);
}

function makeProfile(rows, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "profile-"));
  const db = new DatabaseSync(path.join(dir, "Cookies"));
  db.exec("create table meta (key text, value text); create table cookies (host_key text, name text, value text, encrypted_value blob, path text, expires_utc integer)");
  db.prepare("insert into meta values ('version', ?)").run(String(version));
  for (const [host, name, value, cookiePath, expires = 0, plain = false] of rows) {
    db.prepare("insert into cookies values (?, ?, ?, ?, ?, ?)").run(
      host, name, plain ? value : "", plain ? Buffer.alloc(0) : encrypt(value, host, version >= 24), cookiePath, expires,
    );
  }
  db.close();
  return dir;
}

test("decrypts v10 values, with and without the host hash prefix", () => {
  assert.equal(decryptValue(encrypt("secret", ".google.com", true), true), "secret");
  assert.equal(decryptValue(encrypt("secret", ".google.com", false), false), "secret");
  assert.throws(() => decryptValue(Buffer.from("v11abcdef"), false), /v11.*unsupported/);
});

test("selects unexpired cookies for the host and path, most specific path first", () => {
  const future = (Date.now() + 11_644_473_600_000 + 3600_000) * 1000;
  const past = (Date.now() + 11_644_473_600_000 - 3600_000) * 1000;
  const dir = makeProfile([
    [".google.com", "SID", "root", "/"],
    ["docs.google.com", "FORMS", "specific", "/forms/", future],
    [".google.com", "OLD", "expired", "/", past],
    [".google.com", "OTHERPATH", "no", "/other"],
    ["notgoogle.com", "EVIL", "no", "/"],
    [".google.com", "PLAIN", "unencrypted", "/", 0, true],
  ], 24);
  try {
    assert.equal(cookieHeader("https://docs.google.com/forms/d/e/x/viewform", dir), "FORMS=specific; SID=root; PLAIN=unencrypted");
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});

test("older databases have no host hash; a missing database is an error", () => {
  const dir = makeProfile([[".google.com", "SID", "old", "/"]], 23);
  try {
    assert.equal(cookieHeader("https://docs.google.com/forms/x", dir), "SID=old");
    fs.rmSync(path.join(dir, "Cookies"));
    assert.throws(() => cookieHeader("https://docs.google.com/forms/x", dir), /not found/);
  } finally {
    fs.rmSync(dir, { recursive: true });
  }
});
