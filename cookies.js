// Reads Google login cookies from a local Chromium profile (replaces Python's browser_cookie3).
// Only Chromium's "v10" cookie encryption (fixed key, no keyring) is supported on Linux.
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const CHROME_EPOCH_OFFSET_MS = 11_644_473_600_000; // 1601-01-01 to 1970-01-01
const V10_KEY = crypto.pbkdf2Sync("peanuts", "saltysalt", 1, 16, "sha1");

function decryptValue(encrypted, hostKeyPrefixed) {
  const prefix = encrypted.subarray(0, 3).toString("latin1");
  if (prefix !== "v10") {
    throw new Error(`Chromium cookie encryption "${prefix}" is unsupported (only v10, no system keyring)`);
  }
  const decipher = crypto.createDecipheriv("aes-128-cbc", V10_KEY, Buffer.alloc(16, " "));
  const plain = Buffer.concat([decipher.update(encrypted.subarray(3)), decipher.final()]);
  // Newer Chromium (DB version >= 24) prepends SHA-256(host_key) to the value.
  return (hostKeyPrefixed ? plain.subarray(32) : plain).toString("utf8");
}

// Cookie header for `url`, from the profile's cookie database.
function cookieHeader(url, profileDir = process.env.CHROMIUM_PROFILE || path.join(os.homedir(), ".config", "chromium", "Default")) {
  const { hostname, pathname } = new URL(url);
  const source = path.join(profileDir, "Cookies");
  if (!fs.existsSync(source)) throw new Error(`Chromium cookie database not found: ${source}`);
  // Chromium keeps the live database locked; read a private copy (with its WAL, if any).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cookies-"));
  try {
    for (const suffix of ["", "-wal"]) {
      if (fs.existsSync(source + suffix)) fs.copyFileSync(source + suffix, path.join(tmp, "Cookies" + suffix));
    }
    const db = new DatabaseSync(path.join(tmp, "Cookies"));
    try {
      const version = Number(db.prepare("select value from meta where key = 'version'").get()?.value || 0);
      const now = (Date.now() + CHROME_EPOCH_OFFSET_MS) * 1000;
      const rows = db.prepare(
        "select host_key, name, value, encrypted_value, path from cookies " +
        "where (host_key = '.google.com' or host_key like '%google.com') and (expires_utc = 0 or expires_utc > ?)",
      ).all(now);
      return rows
        .filter((row) => hostname === row.host_key.replace(/^\./, "") || hostname.endsWith("." + row.host_key.replace(/^\./, "")))
        .filter((row) => pathname.startsWith(row.path))
        .sort((a, b) => b.path.length - a.path.length) // most specific path first (RFC 6265)
        .map((row) => {
          const value = row.value || decryptValue(Buffer.from(row.encrypted_value), version >= 24);
          return `${row.name}=${value}`;
        })
        .join("; ");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { cookieHeader, decryptValue, V10_KEY };
