#!/usr/bin/env node
// Watches a WhatsApp group for a Google Form link, fills the form and submits it.
// Usage: tennis-autofill [--list-groups | --history]
//   LINKS_ONLY=1  only report detected links (no Google, no LLM)
//   DRY_RUN=1     read the form and generate answers, never submit
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const forms = require("./forms");
const whatsapp = require("./whatsapp");

const CONFIG_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "tennis-autofiller", "env");

function notify(title, message) {
  // Best effort: a missing notification service must never break the workflow.
  execFile("notify-send", ["-a", "Tennis autofill", title, message], () => {});
}

function openBrowser(url) {
  return new Promise((resolve, reject) => {
    execFile("xdg-open", [url], { timeout: 10_000 }, (error) => (error ? reject(error) : resolve()));
  });
}

const realDeps = {
  getQuestions: forms.getQuestions,
  answerQuestions: forms.answerQuestions,
  submit: forms.submitForm,
  notify,
  openBrowser,
  log: console.log,
  dryRun: false,
};

async function processForm(formUrl, deps = realDeps) {
  const { log } = deps;
  log(`found google form url: ${formUrl}`);
  deps.notify("Google Form found", deps.dryRun ? "Preparing answers (dry run)." : "Preparing answers and submitting the form.");

  let stage = "reading the form";
  try {
    const questions = await deps.getQuestions(formUrl);
    stage = "generating answers";
    const answers = await deps.answerQuestions(questions);
    log("answers:", answers);
    if (deps.dryRun) {
      log("DRY_RUN=1: not submitting");
      return false;
    }
    stage = "submitting the form";
    await deps.submit(formUrl, answers);
  } catch (error) {
    const detail = error instanceof forms.FormError ? error.message : error?.name || "Error";
    let message = `Error while ${stage}: ${detail}.`;
    if (stage === "submitting the form") message += " Submission is unconfirmed; check before submitting again.";
    log(message);
    deps.notify("Google Form failed", message);
    try {
      await deps.openBrowser(formUrl);
    } catch (browserError) {
      log(`Could not open browser: ${browserError?.name || "Error"}`);
    }
    return false;
  }
  log("successfully answered the google form!");
  deps.notify("Google Form submitted", "Successfully sent the form.");
  return true;
}

function loadConfig(env = process.env) {
  if (fs.existsSync(CONFIG_FILE)) process.loadEnvFile(CONFIG_FILE); // real env vars win
  const cfg = {
    group: env.WATCH_CHAT_ID || "",
    linksOnly: env.LINKS_ONLY === "1",
    dryRun: env.DRY_RUN === "1",
    dataDir: env.STATE_DIR || path.join(env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state"), "tennis-autofill"),
    qrFile: path.resolve(env.QR_HTML_PATH || path.join(os.homedir(), "whatsapp-qr.html")),
  };
  return cfg;
}

async function main(argv = process.argv.slice(2)) {
  console.log = console.error; // library chatter (libsignal session dumps) stays off stdout
  const log = (...args) => console.info(...args);
  process.umask(0o077);
  const cfg = loadConfig();
  const onFatal = (error) => {
    log(error.message);
    notify("WhatsApp watcher stopped", error.message);
    process.exitCode = 1;
  };

  if (argv.includes("--list-groups")) {
    return whatsapp.listGroups({ ...cfg, onFatal, print: (line) => process.stdout.write(line + "\n") });
  }
  const missing = ["WATCH_CHAT_ID", ...(cfg.linksOnly ? [] : ["OPENROUTER_API_KEY"])].filter((name) => !process.env[name]);
  if (missing.length) {
    console.error(`Missing ${missing.join(", ")}: set them in ${CONFIG_FILE}`);
    process.exitCode = 1;
    return;
  }
  if (!/^\d+(?:-\d+)?@g\.us$/.test(cfg.group)) {
    console.error("WATCH_CHAT_ID must be a group JID; list yours with --list-groups.");
    process.exitCode = 1;
    return;
  }
  if (argv.includes("--history")) {
    for (const entry of whatsapp.loadCache(cfg.dataDir).values()) {
      if (entry.group === cfg.group) process.stdout.write(JSON.stringify(entry) + "\n");
    }
    return;
  }

  const seen = new Set();
  let queue = Promise.resolve(); // one form at a time, in arrival order
  const session = await whatsapp.watch({
    ...cfg, onFatal, log,
    onForm: ({ link }) => {
      if (seen.has(link)) return;
      seen.add(link);
      queue = queue
        .then(() => (cfg.linksOnly ? log(`LINKS_ONLY: detected ${link}`) : processForm(link, { ...realDeps, dryRun: cfg.dryRun })))
        .catch((error) => log(`Unexpected error: ${error?.name || "Error"}`));
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => session.stop());
}

module.exports = { processForm, loadConfig };
if (require.main === module) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
