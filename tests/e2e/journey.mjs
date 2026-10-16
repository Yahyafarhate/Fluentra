/**
 * End-to-end journey through the real UI (Chromium) against a running app, on a FRESH tenant created through signup:
 *   owner signs up → onboarding (hours, tables, rules) → guest books on the public page → host finds the booking, marks arrival,
 *   seats, completes (with spend) → table awaiting cleaning → marked ready → another guest cancels via the private link
 *   → a new browser session still sees the data.
 * Run:  npm run dev   (other terminal; DB migrated)   then   npm run test:e2e
 */
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const exe = process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined);
const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
const guest = await browser.newContext({ viewport: { width: 420, height: 900 }, locale: "en-GB" });
const staff = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: "en-GB" });
const errors = [];
for (const ctx of [guest, staff]) ctx.on("page", (p) => p.on("pageerror", (e) => errors.push(e.message)));
const step = (m) => console.log("✓", m);
const stamp = Date.now().toString().slice(-7);
const EMAIL = `owner-${stamp}@e2e.test`;
const PASS = "E2e-Passw0rd-123";
const NAME = `Salma Test${stamp}`;
const phone = (n) => `06${stamp}${n}`.slice(0, 10);

async function ready(page) { await page.waitForLoadState("networkidle"); } // hydration + initial data

async function bookOnline(page, slug, name, ph, daysAhead = 1) {
  await page.goto(`${BASE}/book/${slug}`);
  await page.getByRole("heading", { name: /Choose your table/i }).waitFor();
  await ready(page);
  const d = new Date(Date.now() + daysAhead * 86400000).toISOString().slice(0, 10);
  const slots = page.waitForResponse((r) => r.url().includes(`/slots?date=${d}`));
  await page.locator('input[type="date"]').fill(d);
  await slots;
  const slot = page.locator("button[aria-pressed]:not([disabled])").first();
  await slot.waitFor({ timeout: 15000 });
  await slot.click();
  await page.getByLabel(/Full name/i).fill(name);
  await page.getByLabel(/Mobile phone/i).fill(ph);
  await page.waitForTimeout(1500); // anti-bot minimum fill time
  await page.getByRole("button", { name: /Confirm reservation|Request reservation/i }).click();
  await page.waitForURL(/\/r\/.+/, { timeout: 15000 });
}

try {
  // 1 ── owner signs up (14-day trial) and runs onboarding
  const sp = await staff.newPage();
  await sp.goto(`${BASE}/signup`);
  await ready(sp);
  await sp.getByLabel(/Business name/i).fill(`E2E Group ${stamp}`);
  await sp.getByLabel(/First restaurant/i).fill(`Chez E2E ${stamp}`);
  await sp.getByLabel(/^City/i).fill("Rabat");
  await sp.getByLabel(/Your name/i).fill("Owner E2E");
  await sp.getByLabel(/^Email/i).fill(EMAIL);
  await sp.getByLabel(/^Password/i).fill(PASS);
  await sp.getByRole("button", { name: /Create my account/i }).click();
  await sp.waitForURL(/\/app\/onboarding/, { timeout: 20000 });
  step("owner signed up and reached onboarding");

  await ready(sp);
  await sp.getByRole("button", { name: /Save & continue/i }).click();               // profile
  await sp.getByText(/When are you open/i).waitFor();
  await sp.getByRole("button", { name: /Save & continue/i }).click();               // hours (defaults)
  await sp.getByText(/Your tables/i).first().waitFor();
  await sp.getByRole("button", { name: /Create tables/i }).click();                 // 6 + 6 + 2 tables
  await sp.getByText(/Booking rules/i).first().waitFor({ timeout: 20000 });
  await sp.getByRole("button", { name: /Save & continue/i }).click();               // rules
  await sp.getByText(/You're ready/i).waitFor();
  const slug = (await sp.getByText(/\/book\//).first().innerText()).split("/book/")[1].trim();
  assert.ok(slug.length > 2);
  step(`onboarding finished — booking page: /book/${slug}`);

  // 2 ── a guest books on the public page (mobile)
  const gp = await guest.newPage();
  await bookOnline(gp, slug, NAME, phone(11));
  await gp.getByRole("heading", { name: /You're booked!|Request received/i }).waitFor();
  assert.match(await gp.locator("body").innerText(), /Reservation code/i);
  step("guest booked through the public page and landed on the private confirmation link");

  // 3 ── host finds it, checks in, seats, completes
  await sp.goto(`${BASE}/app/reservations`);
  await ready(sp);
  await sp.getByPlaceholder(/Search name/i).fill(NAME);
  await sp.getByText(NAME).first().waitFor({ timeout: 15000 });
  step("staff found the online booking by name");
  await sp.getByText(NAME).first().click();
  const dlg = sp.locator("[role=dialog]").first();
  await dlg.getByRole("button", { name: /Mark arrived/i }).click();
  await sp.getByText(/Guest arrived/i).first().waitFor();
  await dlg.getByRole("button", { name: /^Seat$/ }).click();
  await sp.getByText(/Guests seated/i).first().waitFor();
  const me = await (await sp.request.get(`${BASE}/api/auth/me`)).json();
  const locId = me.locations[0].id;
  let floor = await (await sp.request.get(`${BASE}/api/v1/floor/state?locationId=${locId}`)).json();
  const seated = floor.tables.find((t) => t.current?.guestName === NAME);
  assert.ok(seated, "seated party is on the floor");
  assert.equal(seated.displayStatus, "occupied");
  step(`guest checked in and seated at table ${seated.name} (occupied)`);

  // 3b ── the party asks to change table: move it; the old table goes to cleaning, the new one is occupied
  await dlg.getByRole("button", { name: /^move$/i }).click();
  const pickDlg = sp.locator("[role=dialog]").last();
  await pickDlg.getByText(/Move to another table/i).waitFor();
  const choice = await pickDlg.locator("select option").evaluateAll((o) => o.map((x) => ({ v: x.value, t: x.textContent })).filter((x) => x.v));
  assert.ok(choice.length > 0, "a free table is offered");
  await pickDlg.locator("select").selectOption(choice[0].v);
  await pickDlg.getByRole("button", { name: /Move guests/i }).click();
  await sp.getByText(/Guests moved/i).first().waitFor();
  floor = await (await sp.request.get(`${BASE}/api/v1/floor/state?locationId=${locId}`)).json();
  assert.equal(floor.tables.find((t) => t.id === seated.id).displayStatus, "cleaning");
  const movedTo = floor.tables.find((t) => t.current?.guestName === NAME);
  assert.ok(movedTo && movedTo.id === choice[0].v && movedTo.displayStatus === "occupied");
  seated.id = movedTo.id; seated.name = movedTo.name;
  step(`party moved ${choice[0].t?.split(" ·")[0]} → table; old table awaiting cleaning, new one occupied`);

  await dlg.getByRole("button", { name: /Complete visit/i }).click();
  await sp.locator("[role=dialog]").last().getByLabel(/Total spend/i).fill("480");
  await sp.locator("[role=dialog]").last().getByRole("button", { name: /Complete & release table/i }).click();
  await sp.getByText(/table released/i).first().waitFor();
  floor = await (await sp.request.get(`${BASE}/api/v1/floor/state?locationId=${locId}`)).json();
  assert.equal(floor.tables.find((t) => t.id === seated.id).displayStatus, "cleaning");
  step("visit completed with spend; table is awaiting cleaning");

  // 4 ── mark the table ready from the live floor
  await sp.goto(`${BASE}/app/floor`);
  await ready(sp);
  await sp.getByRole("button", { name: new RegExp(`^${seated.name},`) }).click();
  await sp.getByRole("button", { name: /Mark ready/i }).click();
  await sp.getByText(/Table ready/i).first().waitFor();
  floor = await (await sp.request.get(`${BASE}/api/v1/floor/state?locationId=${locId}`)).json();
  assert.equal(floor.tables.find((t) => t.id === seated.id).displayStatus, "available");
  step("table marked ready and available again");

  // 5 ── dashboard & analytics reflect real data (revenue only from the recorded spend)
  const dash = await (await sp.request.get(`${BASE}/api/v1/dashboard`)).json();
  assert.equal(dash.revenue.recorded, 480, "revenue shows only the spend we entered");
  assert.equal(dash.revenue.avgSpendPerGuest, 240, "480 spend over a party of 2");
  await sp.goto(`${BASE}/app/dashboard`);
  await sp.getByText(/Tables right now/i).waitFor();
  step("dashboard renders live figures");

  // 6 ── a second guest books then cancels through the private link
  const g2 = await guest.newPage();
  await bookOnline(g2, slug, `${NAME} B`, phone(22), 3);
  await g2.getByRole("button", { name: /Cancel reservation/i }).click();
  await g2.getByRole("button", { name: /Yes, cancel/i }).click();
  await g2.getByRole("heading", { name: /Reservation cancelled/i }).waitFor({ timeout: 15000 });
  step("guest cancelled through the secure link");

  // 7 ── persistence in a brand-new session
  const fresh = await browser.newContext({ viewport: { width: 1200, height: 800 }, locale: "en-GB" });
  const fp = await fresh.newPage();
  await fp.goto(`${BASE}/login`);
  await ready(fp);
  await fp.getByLabel(/Email/i).fill(EMAIL);
  await fp.getByLabel(/Password/i).fill(PASS);
  await fp.getByRole("button", { name: /Log in/i }).click();
  await fp.waitForURL(/\/app/);
  await fp.goto(`${BASE}/app/reservations`);
  await ready(fp);
  await fp.getByPlaceholder(/Search name/i).fill(NAME);
  await fp.getByText(NAME).first().waitFor({ timeout: 15000 });
  step("data persisted across a new session");
  assert.deepEqual(errors, [], "no uncaught page errors: " + errors.join("; "));
  console.log("\nE2E journey passed ✔");
} catch (e) {
  console.error("\nE2E journey FAILED:", e.message);
  for (const ctx of [guest, staff]) for (const p of ctx.pages()) await p.screenshot({ path: `e2e-failure-${Date.now()}.png` }).catch(() => undefined);
  process.exitCode = 1;
} finally {
  await browser.close();
}
