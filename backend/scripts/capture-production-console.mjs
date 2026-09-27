// Read-only screenshots of the deployed console. No fixtures or account mutations.
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
const token = process.env.BOXHAVEN_TOKEN;
assert.ok(token, "Set BOXHAVEN_TOKEN to an existing session");
const app = new URL(process.env.BOXHAVEN_APP_URL || "https://app.boxhaven.dev");
const out = resolve(
  process.env.BOXHAVEN_CAPTURE_OUT ||
    "backend/.artifacts/production-design-audit",
);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  executablePath:
    process.env.BOXHAVEN_PLAYWRIGHT_EXECUTABLE ||
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
});
const facts = [];
try {
  const context = await browser.newContext({ reducedMotion: "reduce" });
  await context.addInitScript(
    ({ token, origin }) => {
      if (location.origin === origin)
        localStorage.setItem("boxhaven.backend.token", token);
    },
    { token, origin: app.origin },
  );
  await context.route("**/*", (route) =>
    ["GET", "HEAD", "OPTIONS"].includes(route.request().method())
      ? route.continue()
      : route.abort(),
  );
  const page = await context.newPage();
  for (const [name, width, height] of [
    ["desktop", 1440, 1000],
    ["mobile", 390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    await page.goto(app.href, { waitUntil: "networkidle" });
    await page.getByRole("heading", { name: "Boxes", exact: true }).waitFor();
    await page.screenshot({
      path: resolve(out, `boxes-${name}.png`),
      fullPage: true,
    });
    facts.push({
      viewport: name,
      portraits: await page
        .locator(".hosted-boxes-table .box-avatar")
        .evaluateAll((nodes) =>
          nodes.map((n) => ({
            rect: {
              width: n.getBoundingClientRect().width,
              height: n.getBoundingClientRect().height,
            },
            css: {
              width: getComputedStyle(n).width,
              height: getComputedStyle(n).height,
              flexBasis: getComputedStyle(n).flexBasis,
            },
          })),
        ),
    });
    const first = page.locator(".box-row").first();
    if (await first.count()) {
      await first.click();
      await page.locator(".drawer").waitFor();
      await page.screenshot({
        path: resolve(out, `detail-${name}.png`),
        fullPage: true,
      });
      await page.goto(app.href, { waitUntil: "networkidle" });
    }
    const create = page.getByRole("button", { name: "New box", exact: true });
    if (await create.isEnabled()) {
      await create.click();
      if (await page.getByRole("dialog").count()) {
        await page.locator(".size-loading").waitFor({ state: "hidden" });
        await page
          .getByRole("dialog")
          .screenshot({ path: resolve(out, `create-${name}.png`) });
      }
    }
  }
  await writeFile(
    resolve(out, "measurements.json"),
    JSON.stringify(facts, null, 2),
  );
  console.log(JSON.stringify({ out, facts }));
} finally {
  await browser.close();
}
