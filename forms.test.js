const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const forms = require("./forms");

const FORM_URL = "https://docs.google.com/forms/d/e/test/viewform";
const SUBMIT_URL = "https://docs.google.com/forms/d/e/test/formResponse";
const cookies = () => "SID=test";
const page = (url, text, init = {}) => Object.assign(new Response(text, init), { url });

// Google prefixes its question data with "%.@." and omits the outer "[".
const params = "%.@." + '[1,"Question",null,0,[[123]],null]]'.replaceAll('"', "&quot;");
const QUESTION_HTML = `<div class="x" jsmodel="CP1oW" data-params="${params}"></div>`;

test("questions are parsed from entity-encoded data-params", () => {
  assert.deepEqual(forms.parseQuestions(QUESTION_HTML), { "entry.123": "Question" });
  assert.deepEqual(forms.parseQuestions(QUESTION_HTML.replace('"' + params + '"', `'${params.replaceAll("&quot;", '"')}'`)), { "entry.123": "Question" });
  assert.throws(() => forms.parseQuestions("<html>Form closed</html>"), forms.FormError);
});

test("reading a form sends cookies and rejects login redirects and HTTP errors", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => new Response(QUESTION_HTML));
  assert.deepEqual(await forms.getQuestions(FORM_URL, { cookies }), { "entry.123": "Question" });
  assert.equal(fetchMock.mock.calls[0].arguments[1].headers.cookie, "SID=test");

  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "https://accounts.google.com/login" } }));
  await assert.rejects(forms.getQuestions(FORM_URL, { cookies }), /redirected away/);

  fetchMock.mock.mockImplementation(async () => new Response("", { status: 500 }));
  await assert.rejects(forms.getQuestions(FORM_URL, { cookies }), { name: "HTTPError" });

  fetchMock.mock.mockImplementation(async () => { throw new DOMException("timeout", "TimeoutError"); });
  await assert.rejects(forms.getQuestions(FORM_URL, { cookies }), { name: "TimeoutError" });
});

test("redirects inside docs.google.com are followed", async (t) => {
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    calls++ ? new Response(QUESTION_HTML) : new Response(null, { status: 302, headers: { location: "/forms/d/e/test/viewform?x=1" } }));
  assert.deepEqual(await forms.getQuestions(FORM_URL, { cookies }), { "entry.123": "Question" });
  assert.equal(calls, 2);
});

test("submission requires a confirmation message", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch");
  for (const [html, accepted] of [
    ['<div class="vHW8K">Your response has been recorded.</div>', true],
    ['<div class="freebirdFormviewerViewResponseConfirmationMessage">תודה</div>', true],
    ["<form>Missing required answers</form>", false],
    ['<div class="vHW8K"></div>', false],
  ]) {
    fetchMock.mock.mockImplementation(async () => new Response(html));
    const result = forms.submitForm(FORM_URL, { "entry.1": "test" }, { cookies });
    if (accepted) await result;
    else await assert.rejects(result, /did not confirm/);
    const [url, init] = fetchMock.mock.calls.at(-1).arguments;
    assert.equal(url, SUBMIT_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.body, "entry.1=test");
  }
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 302, headers: { location: "https://accounts.google.com/login" } }));
  await assert.rejects(forms.submitForm(FORM_URL, {}, { cookies }), /redirected away/);
});

test("preview links map to formResponse; unsafe targets are rejected", () => {
  assert.equal(forms.submitUrl(FORM_URL.replace("viewform", "preview") + "?usp=sharing"), SUBMIT_URL + "?usp=sharing");
  for (const bad of ["https://evil.example/forms/viewform", "http://docs.google.com/forms/viewform",
    "https://docs.google.com/forms/unsupported", "https://evil@docs.google.com/forms/d/e/x/viewform",
    "https://docs.google.com:444/forms/d/e/x/viewform"]) {
    assert.throws(() => forms.submitUrl(bad), forms.FormError, bad);
  }
});

test("personal questions are answered locally; the rest go to the LLM", async () => {
  const asked = [];
  const answers = await forms.answerQuestions({
    "entry.1": "שם מלא", "entry.2": "כתובת דואר אלקטרוני", "entry.3": "מספר טלפון נייד",
    "entry.4": "יום שישי - נא לבחור את השעה", "entry.5": "מה צבע אהוב?",
  }, async (question) => { asked.push(question); return "כחול"; });
  assert.deepEqual(asked, ["מה צבע אהוב?"]);
  assert.equal(answers["entry.4"], "שעה 8:00 רמה 5+6+7");
  assert.equal(answers["entry.5"], "כחול");
  assert.ok(answers.emailAddress);
});

test("LLM: empty answers fail once, network errors retry once, success is written to hello.txt", async (t) => {
  const cwd = process.cwd();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ai-"));
  process.chdir(dir);
  t.after(() => { process.chdir(cwd); fs.rmSync(dir, { recursive: true }); });
  const reply = (content) => new Response(JSON.stringify({ choices: [{ message: { content } }] }));

  let fetchImpl = t.mock.fn(async () => reply("  "));
  await assert.rejects(forms.aiAnswer("q", { apiKey: "k", fetchImpl }), /empty answer/);
  assert.equal(fetchImpl.mock.callCount(), 1);

  fetchImpl = t.mock.fn(async () => { throw new TypeError("network"); });
  await assert.rejects(forms.aiAnswer("q", { apiKey: "k", fetchImpl }), TypeError);
  assert.equal(fetchImpl.mock.callCount(), 2);

  fetchImpl = t.mock.fn(async () => reply("שלום"));
  assert.equal(await forms.aiAnswer("q", { apiKey: "k", fetchImpl }), "שלום");
  assert.equal(fs.readFileSync("hello.txt", "utf8"), "שלום");
  assert.equal(fetchImpl.mock.calls[0].arguments[1].headers.authorization, "Bearer k");
});
