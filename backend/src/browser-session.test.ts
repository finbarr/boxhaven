import assert from "node:assert/strict";
import { test } from "node:test";
import { githubCallbackURL, githubReturnPath } from "./browser-session.js";

test("OAuth returns to the original local route including device and invitation parameters", () => {
  for (const path of ["/", "/device?user_code=ABCD-EFGH", "/invite?id=invite-123", "/boxes/work?team=acme#details"]) {
    const callback = githubCallbackURL(`https://app.example.com${path}`);
    assert.equal(new URL(callback).origin + new URL(callback).pathname, "https://app.example.com/auth/github");
    assert.equal(githubReturnPath(callback), path);
  }
});

test("OAuth return parameters cannot send a browser off-site or back into an auth loop", () => {
  for (const destination of [
    "https://evil.example/device", "//evil.example", "\\\\evil.example", "javascript:alert(1)", "data:text/html,hello",
    "/auth/github?returnTo=/device", "/auth/github/", "/signup?mode=signin", "/reset-password?token=secret", "http://[invalid",
  ]) {
    assert.equal(githubReturnPath(`https://app.example.com/auth/github?returnTo=${encodeURIComponent(destination)}`), "/", destination);
  }
  assert.equal(githubReturnPath("https://app.example.com/auth/github"), "/");
  assert.equal(githubReturnPath(githubCallbackURL("https://app.example.com/signup")), "/");
});
