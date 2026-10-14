// Dev helper: log in through the real API and screenshot pages with the preinstalled Chromium.
// usage: node scripts/shot.mjs <email> <out-dir> <width>x<height> /app/dashboard [/app/floor ...]
import { chromium } from "playwright-core";
import fs from "node:fs";
import path from "node:path";
const [, , email, outDir, size, ...paths] = process.argv;
const [w, h] = size.split("x").map(Number);
const base = process.env.BASE_URL ?? "http://localhost:3000";
fs.mkdirSync(outDir, { recursive: true });
const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email, password: process.env.DEMO_PASSWORD ?? "Demo-Pass-2026" }) });
if (!login.ok) { console.error("login failed", login.status, await login.text()); process.exit(1); }
const cookie = login.headers.get("set-cookie").split(";")[0].split("=");
const exe = fs.readdirSync(process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers").find((d) => d.startsWith("chromium")) ;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? undefined, args: ["--no-sandbox"] }).catch(async () => chromium.launch({ args: ["--no-sandbox"] }));
const ctx = await browser.newContext({ viewport: { width: w, height: h }, locale: process.env.LOCALE ?? "en-GB" });
await ctx.addCookies([{ name: cookie[0], value: cookie[1], url: base }]);
if (process.env.LOCALE_COOKIE) await ctx.addCookies([{ name: "fl_locale", value: process.env.LOCALE_COOKIE, url: base }]);
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (m) => { if (m.type() === "error") errors.push("console: " + m.text()); });
for (const p of paths) {
  await page.goto(base + p, { waitUntil: "networkidle" }).catch(() => {});
  await page.waitForTimeout(Number(process.env.WAIT ?? 800));
  const file = path.join(outDir, p.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") + `_${w}.png`);
  await page.screenshot({ path: file, fullPage: process.env.FULL === "1" });
  console.log("saved", file);
}
if (errors.length) console.log("ERRORS:\n" + [...new Set(errors)].join("\n"));
await browser.close();
