import assert from "node:assert/strict";
import { test } from "node:test";
import {
  failedReleaseCheckIntervalMs,
  GitHubReleaseChecker,
  isNewerVersion,
  latestReleaseAPIURL,
  releaseCheckIntervalMs,
} from "./releases.js";

test("release versions compare semantic components", () => {
  assert.equal(isNewerVersion("v0.10.0", "v0.9.4"), true);
  assert.equal(isNewerVersion("0.10.0", "v0.10.0-9-gabcdef"), false);
  assert.equal(isNewerVersion("v0.10.0", "v0.10.1"), false);
  assert.equal(isNewerVersion("v0.10.0", "dev"), true);
  assert.equal(isNewerVersion("not-a-version", "v0.9.0"), false);
});

test("GitHub release checks return and cache an official update", async () => {
  let requests = 0;
  let requestedURL = "";
  let requestedInit: RequestInit | undefined;
  let now = Date.UTC(2026, 7, 10, 12, 0, 0);
  const checker = new GitHubReleaseChecker("v0.1.0", {
    now: () => now,
    fetcher: async (input, init) => {
      requests += 1;
      requestedURL = String(input);
      requestedInit = init;
      return new Response(JSON.stringify({
        tag_name: "v0.2.0",
        html_url: "https://github.com/finbarr/boxhaven/releases/tag/v0.2.0",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });

  assert.deepEqual(await checker.versionStatus(), {
    current_version: "v0.1.0",
    latest_version: "v0.2.0",
    update_available: true,
    release_url: "https://github.com/finbarr/boxhaven/releases/tag/v0.2.0",
  });
  assert.equal(requestedURL, latestReleaseAPIURL);
  assert.equal(new Headers(requestedInit?.headers).get("Accept"), "application/vnd.github+json");
  assert.match(new Headers(requestedInit?.headers).get("User-Agent") || "", /^BoxHaven-backend\//);

  await checker.versionStatus();
  assert.equal(requests, 1, "fresh release result should be cached");
  now += releaseCheckIntervalMs + 1;
  await checker.versionStatus();
  assert.equal(requests, 2, "stale release result should be refreshed");
});

test("release checks fail silently and retry later", async () => {
  let requests = 0;
  let now = Date.UTC(2026, 7, 10, 12, 0, 0);
  const checker = new GitHubReleaseChecker("v0.1.0", {
    now: () => now,
    fetcher: async () => {
      requests += 1;
      throw new Error("offline");
    },
  });

  assert.deepEqual(await checker.versionStatus(), {
    current_version: "v0.1.0",
    update_available: false,
  });
  await checker.versionStatus();
  assert.equal(requests, 1, "failed check should use the retry cache");
  now += failedReleaseCheckIntervalMs + 1;
  await checker.versionStatus();
  assert.equal(requests, 2);
});

test("release links cannot leave the BoxHaven repository", async () => {
  const checker = new GitHubReleaseChecker("v0.1.0", {
    fetcher: async () => new Response(JSON.stringify({
      tag_name: "v0.2.0",
      html_url: "https://example.com/not-boxhaven",
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(
    (await checker.versionStatus()).release_url,
    "https://github.com/finbarr/boxhaven/releases/tag/v0.2.0",
  );
});
