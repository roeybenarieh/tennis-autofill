const test = require("node:test");
const assert = require("node:assert/strict");
const { FormError } = require("./forms");
const { processForm } = require("./index");

const URL_ = "https://docs.google.com/forms/d/e/test/viewform";

function makeDeps(overrides = {}) {
  const titles = [];
  const calls = { submit: 0, browser: 0 };
  return {
    titles, calls,
    deps: {
      getQuestions: async () => ({}),
      answerQuestions: async () => ({}),
      submit: async () => { calls.submit++; },
      notify: (title) => titles.push(title),
      openBrowser: async () => { calls.browser++; },
      log: () => {},
      dryRun: false,
      ...overrides,
    },
  };
}

test("notifications and browser fallback for every failing stage", async () => {
  for (const stage of [null, "getQuestions", "answerQuestions", "submit"]) {
    const { deps, titles, calls } = makeDeps(stage && { [stage]: async () => { throw new FormError("test"); } });
    const ok = await processForm(URL_, deps);
    assert.equal(ok, stage === null, String(stage));
    assert.deepEqual(titles, ["Google Form found", stage ? "Google Form failed" : "Google Form submitted"]);
    assert.equal(calls.browser, stage ? 1 : 0);
  }
});

test("dry run prepares answers without submitting", async () => {
  const { deps, calls, titles } = makeDeps({ dryRun: true });
  assert.equal(await processForm(URL_, deps), false);
  assert.equal(calls.submit, 0);
  assert.deepEqual(titles, ["Google Form found"]);
});

test("unexpected errors are reported by name only; browser failures are survived", async () => {
  const logged = [];
  const { deps } = makeDeps({
    getQuestions: async () => { throw new TypeError("secret detail"); },
    openBrowser: async () => { throw new Error("no desktop"); },
    log: (...args) => logged.push(args.join(" ")),
  });
  assert.equal(await processForm(URL_, deps), false);
  assert.ok(logged.some((line) => line.includes("Error while reading the form: TypeError.")));
  assert.ok(!logged.join("\n").includes("secret detail"));
  assert.ok(logged.some((line) => line.includes("Could not open browser")));
});

test("submission failures warn that the result is unconfirmed", async () => {
  const messages = [];
  const { deps } = makeDeps({ submit: async () => { throw new FormError("Rejected"); }, log: (m) => messages.push(m) });
  await processForm(URL_, deps);
  assert.ok(messages.some((m) => m.includes("Rejected. Submission is unconfirmed")));
});
