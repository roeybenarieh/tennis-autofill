// Google Form reading, answering and submitting. Personal answers are hardcoded on purpose.
const fs = require("node:fs");
const { cookieHeader } = require("./cookies");

// Expected failures: their message is safe to show. Anything else is reported by name only.
class FormError extends Error {}

const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;

function assertFormUrl(formUrl) {
  const url = new URL(formUrl);
  if (url.protocol !== "https:" || url.host !== "docs.google.com" || url.username || url.password
      || !url.pathname.startsWith("/forms/")) {
    throw new FormError("Expected a Google Forms URL");
  }
  return url;
}

// Sends the login cookies, follows redirects only inside docs.google.com so they never leak.
async function googleFetch(url, { method = "GET", body, cookies = cookieHeader } = {}) {
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    const headers = { cookie: cookies(url) };
    if (body) headers["content-type"] = "application/x-www-form-urlencoded";
    const res = await fetch(url, { method, body, headers, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (res.status >= 300 && res.status < 400 && res.headers.has("location")) {
      const next = new URL(res.headers.get("location"), url);
      if (next.protocol !== "https:" || next.host !== "docs.google.com") {
        throw new FormError("Google redirected away from the form; check your login");
      }
      url = next.href;
      if (res.status !== 307 && res.status !== 308) { method = "GET"; body = undefined; }
      continue;
    }
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { name: "HTTPError" });
    return { url, text: await res.text() };
  }
  throw new FormError("Too many redirects");
}

const ENTITIES = { quot: '"', amp: "&", lt: "<", gt: ">", apos: "'" };
function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|quot|amp|lt|gt|apos);/gi, (match, code) => {
    if (code[0] !== "#") return ENTITIES[code.toLowerCase()];
    return String.fromCodePoint(code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
  });
}

// Each question is a <div jsmodel="CP1oW" data-params="%.@.[...]">; maps "entry.<id>" to the text.
function parseQuestions(html) {
  const questions = {};
  for (const [tag] of html.matchAll(/<div\b[^>]*\bjsmodel="CP1oW"[^>]*>/g)) {
    const params = tag.match(/\bdata-params=(?:"([^"]*)"|'([^']*)')/);
    const raw = params && (params[1] ?? params[2]);
    if (!raw) continue;
    const data = JSON.parse("[" + decodeEntities(raw).slice(4)); // drop Google's "%.@." prefix
    questions[`entry.${data[0][4][0][0]}`] = data[0][1];
  }
  if (!Object.keys(questions).length) throw new FormError("No questions found; the form may be closed or require login");
  return questions;
}

async function getQuestions(formUrl, deps) {
  assertFormUrl(formUrl);
  return parseQuestions((await googleFetch(formUrl, deps)).text);
}

function submitUrl(formUrl) {
  const url = assertFormUrl(formUrl);
  // recent links are /preview (or /viewform); submit goes to /formResponse
  url.pathname = url.pathname.replace(/\/(preview|viewform)$/, "/formResponse");
  if (!url.pathname.endsWith("/formResponse")) throw new FormError("Unsupported Google Forms URL");
  return url.href;
}

function isConfirmed(html) {
  const confirmation = html.match(
    /<div\b[^>]*\bclass="[^"]*\b(?:freebirdFormviewerViewResponseConfirmationMessage|vHW8K)\b[^"]*"[^>]*>([\s\S]*?)<\/div>/,
  );
  return !!confirmation && confirmation[1].replace(/<[^>]*>/g, "").trim() !== "";
}

async function submitForm(formUrl, answers, deps) {
  const res = await googleFetch(submitUrl(formUrl), { ...deps, method: "POST", body: new URLSearchParams(answers).toString() });
  if (!isConfirmed(res.text)) throw new FormError("Google did not confirm the submission");
}

async function aiAnswer(question, { apiKey = process.env.OPENROUTER_API_KEY, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) { // one retry on network/server errors
    try {
      const res = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model: "openai/gpt-oss-20b:free",
          messages: [
            {
              role: "system",
              content: "You are a helpful assistant that answers Google form quesetions. "
                + "You are VERY concise, Your answers are VERY short and to the point(NEVER more than one clause). "
                + "In addition, you answer questions as a 20 years old human(e.g. if you are asked what is your famorite toy, you might say pazzles or action figures). "
                + "You answer ONLY in Hebrew.",
            },
            { role: "user", content: question },
          ],
        }),
      });
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { name: "HTTPError" });
      const result = (await res.json()).choices?.[0]?.message?.content;
      if (!result || !result.trim()) throw new FormError("The AI returned an empty answer");
      fs.writeFileSync("hello.txt", result); // debug side effect, kept on purpose
      return result;
    } catch (error) {
      if (error instanceof FormError) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

async function answerQuestions(questions, ask = aiAnswer) {
  const answers = { emailAddress: "roey280404@gmail.com" };
  for (const [entry, question] of Object.entries(questions)) {
    if (question.includes("שם")) answers[entry] = "רואי בן אריה";
    else if (question.includes("דואר")) answers[entry] = "roey280404@gmail.com";
    else if (question.includes("טלפון")) answers[entry] = "0585202050";
    // must match one of the form's radio options exactly
    else if (question.includes("לבחור את השעה")) answers[entry] = "שעה 8:00 רמה 5+6+7";
    else answers[entry] = await ask(question);
  }
  return answers;
}

module.exports = { FormError, parseQuestions, getQuestions, submitUrl, submitForm, isConfirmed, aiAnswer, answerQuestions, googleFetch };
