// Browser journey against a running dev server seeded with `npm run db:reset`:
// server signs in by PIN → opens a table → orders (modifiers) → sends → kitchen bumps on the KDS → cashier pays → back office shows the sale.
import { chromium } from "playwright-core";
import fs from "node:fs";

const base = process.env.BASE_URL ?? "http://localhost:3100";
const out = process.env.SHOTS ?? "e2e-shots";
fs.mkdirSync(out, { recursive: true });
const fail = (m) => { console.error("E2E FAILED:", m); process.exitCode = 1; };
const check = (c, m) => { if (!c) { fail(m); throw new Error(m); } console.log("ok  ", m); };

const login = await fetch(base + "/api/auth/login", { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email: "owner@atlas.demo", password: "Demo-Pass-2026" }) });
const adminCookie = login.headers.get("set-cookie").split(";")[0].split("=");
const outlets = await (await fetch(base + "/api/v1/outlets", { headers: { cookie: adminCookie.join("=") } })).json();
const code = outlets[0].code;

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? (fs.existsSync("/opt/pw-browsers/chromium") ? "/opt/pw-browsers/chromium" : undefined), args: ["--no-sandbox"] });
const errors = [];
const mk = async (w, h) => { const c = await browser.newContext({ viewport: { width: w, height: h }, locale: "fr-FR" }); const p = await c.newPage(); p.on("pageerror", (e) => errors.push(e.message)); p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); }); return { c, p }; };
const shot = (p, n) => p.screenshot({ path: `${out}/${n}.png` });

async function pinLogin(p, name, pin, path = "/pos/login") {
  await p.goto(base + path, { waitUntil: "networkidle" });
  if (await p.getByLabel("Code").count() || await p.locator("input.font-mono").count()) { await p.locator("input.font-mono").fill(code); await p.getByRole("button", { name: "Continuer" }).click(); }
  await p.getByRole("button", { name: new RegExp(name) }).click();
  for (const d of pin) await p.keyboard.press(d);
  await p.keyboard.press("Enter");
}

// ───── server on a tablet-size POS ─────
const srv = await mk(1280, 800); const p = srv.p;
await pinLogin(p, "Omar Fassi", "6802");
await p.waitForURL(/\/pos$/); await p.waitForSelector("text=Salle principale");
await shot(p, "01-floor"); check(true, "PIN login lands on the floor plan");

const free = p.locator(`button[aria-label$="libre"]`).first();
const tableLabel = (await free.getAttribute("aria-label")).split(" ")[0];
await free.click();
await p.getByRole("button", { name: "3", exact: true }).click();
await p.getByRole("button", { name: "Ouvrir", exact: true }).click();
await p.waitForURL(/\/pos\/order\//); check(true, "table opened with 3 covers");

await p.getByRole("button", { name: /Entrecôte grillée/ }).first().click();
await p.getByRole("button", { name: "À point" }).click();
await p.getByRole("button", { name: /^Ajouter/ }).click();
await p.getByRole("button", { name: /Harira/ }).first().click();
await p.getByRole("button", { name: /Thé à la menthe/ }).first().click();
await p.getByRole("button", { name: "Normal" }).click();
await p.getByRole("button", { name: /^Ajouter/ }).click();
await p.waitForSelector("text=Entrecôte grillée >> nth=1");
// the steak requires a cooking choice: adding without it must not be possible
const total = await p.locator("aside dd.text-2xl").innerText();
check(/\d/.test(total), `ticket total shown (${total})`);
await shot(p, "02-order-draft");
await p.getByRole("button", { name: /^Envoyer/ }).click();
await p.waitForSelector("text=envoyé");
await shot(p, "03-order-sent"); check(true, "order sent: starter and drink fired, main course held");
check(await p.getByText("en attente").count() > 0, "the main course (course 2) is held until fired");
await p.getByRole("button", { name: "Lancer le service 2" }).click();
await p.waitForSelector("text=Entrecôte grillée");
await p.waitForFunction(() => !document.body.innerText.includes("Lancer le service 2"));
check(true, "course 2 fired");

// ───── kitchen display ─────
const kit = await mk(1280, 800); const k = kit.p;
await pinLogin(k, "Chef Hamza", "8024", "/pos/login?kds=1");
await k.waitForURL(/\/kds$/);
await k.getByText("Cuisine").first().click();
await k.waitForSelector("text=Harira");
await shot(k, "04-kds-ticket");
check(await k.getByText("Entrecôte grillée").count() > 0, "KDS shows the steak with its modifiers");
const mine = k.locator("article", { hasText: `Table ${tableLabel}` }).filter({ hasText: "Entrecôte" });
check(await mine.count() === 1, `our ticket for table ${tableLabel} is on the KDS`);
await mine.getByRole("button", { name: "Terminer (tout prêt)" }).click();
await k.waitForSelector("text=Tout est à jour", { timeout: 8000 }).catch(() => undefined);
await shot(k, "05-kds-bumped");

// ───── back on the POS: items are ready → served, then pay in cash ─────
await p.reload({ waitUntil: "networkidle" });
await p.waitForSelector("text=prêt");
check(true, "kitchen status 'prêt' flows back to the POS");
await p.getByRole("button", { name: /^Servi/ }).click();
await p.getByRole("button", { name: "Payer", exact: true }).click();
await p.getByRole("button", { name: "Appoint" }).click();
await shot(p, "06-pay");
await p.getByRole("button", { name: /^Encaisser/ }).click();
await p.waitForSelector("text=Payé en totalité");
await shot(p, "07-paid"); check(true, "cash payment recorded and order closed");

// ───── back office ─────
const adm = await mk(1280, 900); const a = adm.p;
await a.goto(base + "/admin/login", { waitUntil: "networkidle" });
await a.getByLabel("E-mail").fill("owner@atlas.demo"); await a.getByLabel("Mot de passe").fill("Demo-Pass-2026");
await a.getByRole("button", { name: "Se connecter" }).click();
await a.waitForURL(/\/admin$/); await a.getByRole("button", { name: "Aujourd'hui" }).click(); await a.waitForSelector("text=Total facturé");
await a.waitForTimeout(800);
await shot(a, "08-admin-dashboard"); check(true, "dashboard shows today's sales");
for (const [path, wait, name] of [["/admin/reports", "text=Produits", "09-reports"], ["/admin/menu", "text=Nouveau produit", "10-menu"], ["/admin/floor", "text=Terrasse", "11-floor-editor"], ["/admin/end-of-day", "text=Clôturer la journée", "12-end-of-day"], ["/admin/integration", "text=La caisse n'attend jamais Fluentra", "13-integration"], ["/admin/staff", "text=Nouvel employé", "14-staff"]]) {
  await a.goto(base + path, { waitUntil: "networkidle" }); await a.waitForSelector(wait).catch(() => fail(`page ${path} did not render ${wait}`)); await shot(a, name);
}
await browser.close();
if (errors.length) { console.error("Browser errors:\n" + [...new Set(errors)].join("\n")); process.exitCode = 1; }
else console.log("\nE2E journey passed");
