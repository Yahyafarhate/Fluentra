/**
 * Demo data for development. Deterministic (seeded PRNG). Refuses to run in production.
 * Notifications/campaigns are produced through the real automation pipeline and are therefore recorded as SIMULATED.
 */
import { loadEnv } from "./load-env";
loadEnv();

export const DEMO_PASSWORD = "Demo-Pass-2026";

function mulberry32(a: number) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export async function seed(opts: { force?: boolean } = {}) {
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_SEED_IN_PRODUCTION !== "yes-i-am-sure") throw new Error("Refusing to seed demo data in production");
  const { withSystem, closePool } = await import("../src/lib/db");
  const { hashPassword } = await import("../src/lib/auth");
  const { seedDefaultAutomations } = await import("../src/server/automation/service");
  const { createLocationWithDefaults } = await import("../src/server/tenants/signup");
  const { localToUtc, todayLocal, utcToLocal } = await import("../src/lib/tz");
  const { addDays, isoWeekday } = await import("../src/lib/time");
  const { pickTables, durationFor } = await import("../src/server/availability/engine");
  const { shortCode } = await import("../src/lib/ids");

  const rnd = mulberry32(20260214);
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
  const chance = (p: number) => rnd() < p;

  const existing = await withSystem((db) => db.one<{ n: number }>(`SELECT count(*)::int n FROM organizations`));
  if (existing.n > 0 && !opts.force) {
    console.log("Database already contains organizations — run `npm run db:reset` to start from a clean demo.");
    return;
  }
  const hash = await hashPassword(DEMO_PASSWORD);

  await withSystem(async (db) => {
    // ───────── platform admin ─────────
    await db.exec(`INSERT INTO users (email, password_hash, name, is_super_admin, locale) VALUES ('admin@fluentra.dev',$1,'Platform Admin',true,'en')`, [hash]);

    // ───────── organization 1: Atlas Hospitality Group ─────────
    const org = await db.one<{ id: string }>(`INSERT INTO organizations (name, slug, plan_id, status, billing_provider, current_period_end) VALUES ('Atlas Hospitality Group','atlas-hospitality','pro','active','simulated', now() + interval '21 days') RETURNING id`);
    const org2 = await db.one<{ id: string }>(`INSERT INTO organizations (name, slug, plan_id, status, trial_ends_at) VALUES ('Café Médina SARL','cafe-medina','starter','trial', now() + interval '9 days') RETURNING id`);
    await seedDefaultAutomations(db, org.id);
    await seedDefaultAutomations(db, org2.id);

    const mkUser = async (email: string, name: string, locale = "fr") =>
      (await db.one<{ id: string }>(`INSERT INTO users (email, password_hash, name, locale) VALUES ($1,$2,$3,$4) RETURNING id`, [email, hash, name, locale])).id;

    // ───────── Location 1: Le Riad Atlas (Casablanca) ─────────
    const riad = await createLocationWithDefaults(db, org.id, { name: "Le Riad Atlas", city: "Casablanca", address: "Boulevard de la Corniche, Ain Diab", phone: "+212522000111", locale: "fr" });
    await db.exec(`UPDATE locations SET description=$2, policy_text=$3, brand_color='#a8803f', public_waitlist_enabled=true, email='reservations@riad-atlas.example',
        max_covers_per_slot=40, deposit_enabled=true, deposit_amount_per_guest=150, deposit_min_party=8, max_party_online=10, website='https://riad-atlas.example',
        cover_url=NULL WHERE id=$1`, [riad.id,
      "Cuisine marocaine contemporaine dans un riad face à l'océan. Tajines revisités, pastilla signature et cave à thés. Salle principale, terrasse sur la Corniche et salon privé.",
      "Annulation gratuite jusqu'à 4 h avant. Au-delà, ou en cas d'absence, un acompte peut être retenu pour les groupes de 8 personnes et plus."]);
    await db.exec(`UPDATE services SET days='{2,3,4,5,6,7}', start_time='12:30', last_seating='14:30', max_covers=70 WHERE location_id=$1 AND name='Lunch'`, [riad.id]);
    await db.exec(`UPDATE services SET start_time='19:30', last_seating='22:30', max_covers=120 WHERE location_id=$1 AND name='Dinner'`, [riad.id]);
    const sIn = (await db.one<{ id: string }>(`SELECT id FROM sections WHERE location_id=$1`, [riad.id])).id;
    const sTer = (await db.one<{ id: string }>(`INSERT INTO sections (org_id, location_id, name, kind) VALUES ($1,$2,'Terrasse Corniche','outdoor') RETURNING id`, [org.id, riad.id])).id;
    const sPriv = (await db.one<{ id: string }>(`INSERT INTO sections (org_id, location_id, name, kind) VALUES ($1,$2,'Salon privé','private') RETURNING id`, [org.id, riad.id])).id;
    const fTer = (await db.one<{ id: string }>(`INSERT INTO floors (org_id, location_id, name, sort) VALUES ($1,$2,'Terrasse',2) RETURNING id`, [org.id, riad.id])).id;
    const fPriv = (await db.one<{ id: string }>(`INSERT INTO floors (org_id, location_id, name, sort) VALUES ($1,$2,'Salon privé',3) RETURNING id`, [org.id, riad.id])).id;

    const addTable = async (loc: string, floor: string, section: string | null, name: string, cap: number, shape: string, x: number, y: number, w: number, h: number, online = true, min = 1) =>
      (await db.one<{ id: string }>(`INSERT INTO tables (org_id, location_id, floor_id, section_id, name, min_capacity, capacity, shape, x, y, w, h, bookable_online) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
        [org.id, loc, floor, section, name, min, cap, shape, x, y, w, h, online])).id;
    const riadTables: Record<string, string> = {};
    for (let i = 0; i < 6; i++) riadTables[`M${i + 1}`] = await addTable(riad.id, riad.floorId, sIn, `M${i + 1}`, 2, "rect", 60 + i * 150, 70, 90, 64);
    for (let i = 0; i < 6; i++) riadTables[`M${i + 7}`] = await addTable(riad.id, riad.floorId, sIn, `M${i + 7}`, 4, "rect", 60 + i * 150, 250, 110, 80);
    riadTables.M13 = await addTable(riad.id, riad.floorId, sIn, "M13", 6, "rect", 120, 450, 170, 90);
    riadTables.M14 = await addTable(riad.id, riad.floorId, sIn, "M14", 6, "rect", 420, 450, 170, 90);
    riadTables.B1 = await addTable(riad.id, riad.floorId, sIn, "Bar 1", 2, "round", 760, 450, 70, 70, false);
    for (let i = 0; i < 4; i++) riadTables[`T${i + 1}`] = await addTable(riad.id, fTer, sTer, `T${i + 1}`, i < 2 ? 2 : 4, "round", 80 + i * 200, 120, 90, 90);
    riadTables.T5 = await addTable(riad.id, fTer, sTer, "T5", 6, "rect", 200, 380, 180, 90);
    riadTables.P1 = await addTable(riad.id, fPriv, sPriv, "Salon", 14, "rect", 250, 200, 400, 140, true, 8);
    const combo = async (loc: string, name: string, cap: number, min: number, ids: string[]) => {
      const c = await db.one<{ id: string }>(`INSERT INTO table_combinations (org_id, location_id, name, capacity, min_capacity) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [org.id, loc, name, cap, min]);
      for (const t of ids) await db.exec(`INSERT INTO table_combination_tables (combination_id, table_id, org_id) VALUES ($1,$2,$3)`, [c.id, t, org.id]);
    };
    await combo(riad.id, "M7+M8", 8, 5, [riadTables.M7, riadTables.M8]);
    await combo(riad.id, "M9+M10", 8, 5, [riadTables.M9, riadTables.M10]);
    await combo(riad.id, "M7+M8+M9", 12, 9, [riadTables.M7, riadTables.M8, riadTables.M9]);
    await combo(riad.id, "T1+T2", 4, 3, [riadTables.T1, riadTables.T2]);

    // ───────── Location 2: Skyline Rooftop (Marrakech) ─────────
    const sky = await createLocationWithDefaults(db, org.id, { name: "Skyline Rooftop Marrakech", city: "Marrakech", address: "Avenue Mohammed VI, Guéliz", phone: "+212524000222", locale: "en" });
    await db.exec(`UPDATE locations SET description=$2, policy_text=$3, brand_color='#2f4858', email='hello@skyline-rooftop.example', max_party_online=8, slot_interval_min=30 WHERE id=$1`, [sky.id,
      "Rooftop lounge and grill with panoramic views of the Atlas. Sunset cocktails, grilled seafood and live DJ sets on weekends.",
      "Free cancellation up to 4 hours before. Tables are held for 15 minutes after the reservation time."]);
    await db.exec(`DELETE FROM services WHERE location_id=$1`, [sky.id]);
    await db.exec(`INSERT INTO services (org_id, location_id, name, days, start_time, last_seating, sort) VALUES ($1,$2,'Sunset & Dinner','{1,2,3,4,5,6,7}','17:30','22:30',1)`, [org.id, sky.id]);
    const sRoof = (await db.one<{ id: string }>(`SELECT id FROM sections WHERE location_id=$1`, [sky.id])).id;
    await db.exec(`UPDATE sections SET name='Rooftop deck' WHERE id=$1`, [sRoof]);
    const sBar = (await db.one<{ id: string }>(`INSERT INTO sections (org_id, location_id, name, kind) VALUES ($1,$2,'Lounge bar','bar') RETURNING id`, [org.id, sky.id])).id;
    const skyTables: Record<string, string> = {};
    for (let i = 0; i < 8; i++) skyTables[`R${i + 1}`] = await addTable(sky.id, sky.floorId, sRoof, `R${i + 1}`, i < 3 ? 2 : i < 7 ? 4 : 8, i < 3 ? "round" : "rect", 70 + (i % 4) * 220, i < 4 ? 80 : 300, i < 3 ? 80 : 120, i < 3 ? 80 : 84);
    for (let i = 0; i < 4; i++) skyTables[`B${i + 1}`] = await addTable(sky.id, sky.floorId, sBar, `L${i + 1}`, 4, "square", 140 + i * 180, 500, 80, 80);
    await combo(sky.id, "R4+R5", 8, 5, [skyTables.R4, skyTables.R5]);

    // ───────── staff ─────────
    const staff: Array<[string, string, string, string[] | null]> = [
      ["owner@atlas.demo", "Karim Bennani", "owner", null],
      ["gm@atlas.demo", "Salma Chraibi", "general_manager", null],
      ["manager@atlas.demo", "Youssef Lahlou", "restaurant_manager", [riad.id]],
      ["host@atlas.demo", "Nadia Berrada", "host", [riad.id]],
      ["service@atlas.demo", "Omar Fassi", "service", [riad.id]],
      ["marketing@atlas.demo", "Imane Kettani", "marketing_manager", null],
      ["host.marrakech@atlas.demo", "Hamza Amrani", "host", [sky.id]],
    ];
    for (const [email, name, role, locs] of staff) {
      const uid = await mkUser(email, name, name === "Hamza Amrani" ? "en" : "fr");
      await db.exec(`INSERT INTO memberships (org_id, user_id, role, location_ids) VALUES ($1,$2,$3,$4)`, [org.id, uid, role, locs]);
    }
    const medOwner = await mkUser("owner@medina.demo", "Rachid Skalli");
    await db.exec(`INSERT INTO memberships (org_id, user_id, role) VALUES ($1,$2,'owner')`, [org2.id, medOwner]);
    const med = await createLocationWithDefaults(db, org2.id, { name: "Café Médina", city: "Fès", address: "Talaa Kebira, Fès el-Bali", locale: "fr" });
    const medTables: string[] = [];
    for (let i = 0; i < 6; i++) medTables.push(await db.one<{ id: string }>(`INSERT INTO tables (org_id, location_id, floor_id, name, capacity, x, y) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [org2.id, med.id, med.floorId, `C${i + 1}`, i < 3 ? 2 : 4, 60 + (i % 3) * 200, 80 + Math.floor(i / 3) * 200]).then((r) => r.id));

    // ───────── guests ─────────
    const first = ["Karim", "Salma", "Youssef", "Imane", "Omar", "Nadia", "Mehdi", "Leila", "Amine", "Sofia", "Hamza", "Meryem", "Anas", "Zineb", "Reda", "Houda", "Walid", "Kenza", "Tarik", "Ghita", "Yassine", "Sara", "Adil", "Hajar", "Rachid", "Lina", "Bilal", "Soukaina", "Mounir", "Dounia"];
    const last = ["Alaoui", "Benjelloun", "Tazi", "Fassi", "Berrada", "Chraibi", "Lahlou", "Kettani", "Bennani", "El Idrissi", "Sebti", "Mansouri", "Cherkaoui", "Benkirane", "Skalli", "Amrani", "Naciri", "Zniber", "Guessous", "Filali"];
    const expats: Array<[string, string]> = [["Pierre", "Martin"], ["Emma", "Johnson"], ["Lucas", "Dubois"], ["Sophie", "Laurent"], ["James", "Walker"], ["Anna", "Müller"], ["Carlos", "Fernández"], ["Chloé", "Bernard"], ["Tom", "Hughes"], ["Marta", "Rossi"]];
    const allergies = ["arachides", "fruits à coque", "gluten", "lactose", "fruits de mer", "œufs"];
    const dietary = ["végétarien", "sans porc", "halal strict", "pescétarien", "sans alcool"];
    const tags = ["habitué", "presse", "business", "famille", "influenceur", "anniversaire"];
    const customers: Array<{ id: string; name: string; vip: boolean; org: string }> = [];
    const usedPhones = new Set<string>();
    const todayStr = await todayLocal(db, "Africa/Casablanca");
    const mkCustomer = async (orgId: string, name: string, i: number) => {
      let phone: string; do { phone = `+2126${String(10000000 + Math.floor(rnd() * 89999999))}`; } while (usedPhones.has(phone)); usedPhones.add(phone);
      const email = chance(0.75) ? `${name.toLowerCase().normalize("NFD").replace(/[^a-z ]/g, "").replace(/ /g, ".")}${i}@example.com` : null;
      const vip = chance(0.1);
      const bd = chance(0.45) ? addDays(todayStr, Math.floor(rnd() * 70) - 10).replace(/^\d{4}/, String(1965 + Math.floor(rnd() * 40))) : null;
      const c = await db.one<{ id: string }>(
        `INSERT INTO customers (org_id, name, phone, email, language, vip, tags, dietary, allergies, birthday, consent_email, consent_sms, consent_whatsapp, source, seating_preferences, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'seed',$14,$15) RETURNING id`,
        [orgId, name, phone, email, pick(["fr", "fr", "fr", "en", "ar"]), vip, chance(0.3) ? [pick(tags)] : [], chance(0.2) ? [pick(dietary)] : [], chance(0.12) ? [pick(allergies)] : [], bd,
          !!email && chance(0.6), chance(0.35), chance(0.3), chance(0.25) ? pick(["Terrasse si possible", "Table calme", "Près de la fenêtre", "Banquette"]) : null,
          vip ? "Client fidèle — à accueillir personnellement." : null]);
      return { id: c.id, name, vip, org: orgId };
    };
    let ci = 0;
    for (let i = 0; i < 56; i++) customers.push(await mkCustomer(org.id, `${pick(first)} ${pick(last)}`, ci++));
    for (const [f, l] of expats) customers.push(await mkCustomer(org.id, `${f} ${l}`, ci++));
    for (let i = 0; i < 6; i++) customers.push(await mkCustomer(org2.id, `${pick(first)} ${pick(last)}`, ci++));
    for (const c of customers) {
      for (const [ch, col] of [["email", "consent_email"], ["sms", "consent_sms"], ["whatsapp", "consent_whatsapp"]] as const) {
        const on = await db.one<{ v: boolean }>(`SELECT ${col} AS v FROM customers WHERE id=$1`, [c.id]);
        if (on.v) await db.exec(`INSERT INTO consents (org_id, customer_id, channel, granted, source) VALUES ($1,$2,$3,true,'booking_form')`, [c.org, c.id, ch]);
      }
    }

    // ───────── reservations (history + today + future) allocated with the real engine ─────────
    type Loc = { id: string; name: string; tz: string; floor: string; tables: Record<string, string>; times: string[]; popularity: number };
    const now = new Date();
    const ctxFor = async (l: { id: string }) => {
      const tablesRows = await db.query<{ id: string; name: string; minCapacity: number; capacity: number; sectionId: string | null; floorId: string; bookableOnline: boolean; status: "available"; active: boolean }>(
        `SELECT id, name, min_capacity, capacity, section_id, floor_id, bookable_online, 'available'::text AS status, active FROM tables WHERE location_id=$1`, [l.id]);
      const combos = await db.query<{ id: string; name: string; minCapacity: number; capacity: number; tableIds: string[] }>(
        `SELECT c.id, c.name, c.min_capacity, c.capacity, array_agg(ct.table_id) AS table_ids FROM table_combinations c JOIN table_combination_tables ct ON ct.combination_id=c.id WHERE c.location_id=$1 GROUP BY c.id`, [l.id]);
      return { tables: tablesRows, combos };
    };
    const locations = [
      { l: riad, org: org.id, rules: [{ maxParty: 2, minutes: 90 }, { maxParty: 4, minutes: 105 }, { maxParty: 8, minutes: 120 }, { maxParty: 999, minutes: 150 }], lunch: ["12:30", "13:00", "13:30", "14:00"], dinner: ["19:30", "20:00", "20:30", "21:00", "21:30", "22:00"], closedWd: 1, pop: 0.8, buffer: 10 },
      { l: sky, org: org.id, rules: [{ maxParty: 2, minutes: 90 }, { maxParty: 4, minutes: 105 }, { maxParty: 8, minutes: 120 }, { maxParty: 999, minutes: 150 }], lunch: [], dinner: ["17:30", "18:00", "18:30", "19:00", "19:30", "20:00", "20:30", "21:00", "21:30"], closedWd: 0, pop: 0.7, buffer: 10 },
      { l: med, org: org2.id, rules: [{ maxParty: 2, minutes: 90 }, { maxParty: 999, minutes: 120 }], lunch: ["12:00", "12:30", "13:00"], dinner: ["19:00", "19:30", "20:00"], closedWd: 0, pop: 0.5, buffer: 10 },
    ];
    const sources = ["online", "online", "online", "phone", "phone", "whatsapp", "instagram", "walk_in", "staff", "google"] as const;
    const occasions = [null, null, null, null, null, "Anniversaire", "Dîner d'affaires", "Anniversaire de mariage", "Fiançailles"];
    const requests = [null, null, null, null, "Table calme", "Chaise bébé", "Allergie aux arachides", "Vue sur la mer", "Gâteau d'anniversaire", "Accès PMR", "Menu végétarien"];
    let resCount = 0;
    const usedDup = new Set<string>();

    for (const L of locations) {
      const { tables, combos } = await ctxFor(L.l);
      const busy: Array<{ tableId: string; start: number; end: number }> = [];
      const locCustomers = customers.filter((c) => c.org === L.org);
      const svc = await db.query<{ id: string; name: string; days: number[]; startTime: string }>(`SELECT id, name, days, to_char(start_time,'HH24:MI') AS start_time FROM services WHERE location_id=$1`, [L.l.id]);
      for (let d = -45; d <= 14; d++) {
        const date = addDays(todayStr, d);
        const wd = isoWeekday(date);
        if (L.l.id === riad.id && wd === 1) continue; // Riad closed Mondays
        if (L.l.id === riad.id && d === 20) continue;
        const weekend = wd >= 5;
        const perService = (times: string[]) => {
          if (!times.length) return 0;
          const base = (weekend ? 17 : 9) * L.pop * (d > 0 ? Math.max(0.35, 1 - d * 0.045) : 1) * (0.7 + rnd() * 0.6);
          return Math.max(0, Math.round(base));
        };
        for (const [times, svcName] of [[L.lunch, "Lunch"], [L.dinner, "Dinner"]] as Array<[string[], string]>) {
          const n = perService(times);
          for (let k = 0; k < n; k++) {
            const time = pick(times);
            const party = pick([2, 2, 2, 2, 3, 4, 4, 4, 5, 6, 6, 8, 10]);
            const start = await localToUtc(db, date, time, L.l.id === riad.id || L.l.id === sky.id ? "Africa/Casablanca" : "Africa/Casablanca");
            const dur = durationFor(L.rules, party);
            const end = new Date(start.getTime() + dur * 60000);
            const t = pickTables({ tables, combos, busy, start: start.getTime(), end: end.getTime() + L.buffer * 60000, party });
            if (!t) continue;
            for (const id of t) busy.push({ tableId: id, start: start.getTime(), end: end.getTime() + L.buffer * 60000 });
            const cust = pick(locCustomers);
            const cr = await db.one<{ phone: string | null; email: string | null; vip: boolean; name: string }>(`SELECT phone, email, vip, name FROM customers WHERE id=$1`, [cust.id]);
            const dupKey = `${L.l.id}|${start.toISOString()}|${cr.phone}`;
            if (usedDup.has(dupKey)) continue; usedDup.add(dupKey);
            const svcRow = svc.find((s) => s.name === svcName || (svc.length === 1)) ?? null;
            // status by time
            let status: string;
            const endMs = end.getTime();
            if (d < 0 || endMs < now.getTime()) status = chance(0.07) ? "cancelled" : chance(0.05) ? "no_show" : "completed";
            else if (start.getTime() <= now.getTime()) status = "seated";
            else if (start.getTime() - now.getTime() < 15 * 60000 && chance(0.5)) status = "arrived";
            else status = chance(0.82) ? "confirmed" : "pending";
            if (d > 0 && status === "pending" && chance(0.5)) status = "confirmed";
            const source = pick(sources);
            const code = shortCode(6);
            const res = await db.one<{ id: string }>(
              `INSERT INTO reservations (org_id, location_id, customer_id, code, guest_name, guest_phone, guest_email, party_size, service_date, start_at, end_at, service_id, status, source,
                  occasion, special_requests, is_vip, arrived_at, seated_at, completed_at, cancelled_at, cancelled_by, no_show_at, created_at)
               VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                  CASE WHEN $13 IN ('arrived','seated','completed') THEN $10::timestamptz - interval '3 minutes' END,
                  CASE WHEN $13 IN ('seated','completed') THEN $10::timestamptz + interval '4 minutes' END,
                  CASE WHEN $13 = 'completed' THEN LEAST($11::timestamptz - interval '8 minutes', $10::timestamptz + interval '1 minute' * (45 + $8::int * 9)) END,
                  CASE WHEN $13 = 'cancelled' THEN $10::timestamptz - interval '1 day' END, CASE WHEN $13 = 'cancelled' THEN 'guest' END,
                  CASE WHEN $13 = 'no_show' THEN $10::timestamptz + interval '20 minutes' END, $10::timestamptz - interval '1 day' * (1 + floor(random() * 12)))
               RETURNING id`,
              [L.org, L.l.id, cust.id, code, cr.name, cr.phone, cr.email, party, date, start, end, svcRow?.id ?? null, status, source,
                pick(occasions), pick(requests), cr.vip, ]);
            if (status === "cancelled" || status === "no_show") { for (const id of t) { const i = busy.findIndex((b) => b.tableId === id && b.start === start.getTime()); if (i >= 0) busy.splice(i, 1); } resCount++; continue; }
            for (const id of t) {
              await db.exec(`INSERT INTO reservation_tables (reservation_id, table_id, org_id, location_id, during) VALUES ($1,$2,$3,$4,tstzrange($5,$6))`,
                [res.id, id, L.org, L.l.id, start, new Date(end.getTime() + L.buffer * 60000)]);
            }
            if (status === "completed" || status === "seated") {
              const left = status === "completed" ? new Date(start.getTime() + (45 + party * 9) * 60000 + Math.floor(rnd() * 20) * 60000) : null;
              const spend = status === "completed" && chance(0.62) ? Math.round(party * (180 + rnd() * 320) / 10) * 10 : null;
              if (left) await db.exec(`UPDATE reservation_tables SET during = tstzrange(lower(during), GREATEST($2::timestamptz, lower(during) + interval '1 minute')) WHERE reservation_id=$1`, [res.id, left]);
              await db.exec(`INSERT INTO visits (org_id, location_id, customer_id, reservation_id, party_size, table_ids, seated_at, left_at, spend_amount, spend_source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
                [L.org, L.l.id, cust.id, res.id, party, t, new Date(start.getTime() + 4 * 60000), left, spend, spend ? "manual" : null]);
              if (status === "seated") await db.exec(`UPDATE tables SET status='occupied' WHERE id = ANY($1)`, [t]);
              else if (left && left.getTime() > now.getTime() - 15 * 60000 && d === 0) await db.exec(`UPDATE tables SET status='cleaning' WHERE id = ANY($1)`, [t]);
            }
            resCount++;
          }
        }
      }
    }
    await db.exec(`UPDATE tables SET status='available' WHERE status='occupied' AND id NOT IN (SELECT rt.table_id FROM reservation_tables rt JOIN reservations r ON r.id=rt.reservation_id WHERE r.status='seated')`);
    // one table blocked for maintenance
    await db.exec(`UPDATE tables SET status='blocked', blocked_reason='Pied cassé — réparation demain' WHERE id=$1`, [riadTables.M12]);
    await db.exec(`UPDATE tables SET status='available' WHERE id=$1 AND status IN ('occupied','cleaning')`, [riadTables.M12]);

    // special days
    await db.exec(`INSERT INTO special_days (org_id, location_id, date, closed, label) VALUES ($1,$2,$3,true,'Fermeture annuelle — Aïd')`, [org.id, riad.id, addDays(todayStr, 20)]);
    await db.exec(`INSERT INTO special_days (org_id, location_id, date, closed, label, start_time, last_seating) VALUES ($1,$2,$3,false,'Soirée gala du Nouvel An','19:00','21:00')`, [org.id, riad.id, addDays(todayStr, 30)]);

    // ───────── waitlist (live today + 30 days of history for stats) ─────────
    const wlPeople: Array<[string, number, string | null]> = [["Famille Alaoui", 5, null], ["M. Walker", 2, "accessibility"], ["Zineb & amis", 4, null]];
    for (const [i, [name, party, reason]] of wlPeople.entries()) {
      await db.exec(`INSERT INTO waitlist_entries (org_id, location_id, name, phone, party_size, status, priority, priority_reason, quoted_wait_min, joined_at, source)
                      VALUES ($1,$2,$3,$4,$5,'waiting',$6,$7,$8, now() - interval '1 minute' * $9,'staff')`,
        [org.id, riad.id, name, `+2126610000${i}0`, party, reason === "accessibility" ? 2 : 0, reason, 20 + i * 10, 12 - i * 3]);
    }
    for (let i = 0; i < 60; i++) {
      const seated = chance(0.72); const joined = new Date(now.getTime() - (1 + rnd() * 29) * 86400000);
      const wait = 8 + Math.floor(rnd() * 35);
      await db.exec(`INSERT INTO waitlist_entries (org_id, location_id, name, phone, party_size, status, quoted_wait_min, joined_at, seated_at, closed_at, source)
                      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'staff')`,
        [org.id, riad.id, `Walk-in ${i + 1}`, null, pick([2, 2, 3, 4, 4, 5]), seated ? "seated" : pick(["removed", "cancelled"]), wait + 5, joined, seated ? new Date(joined.getTime() + wait * 60000) : null, new Date(joined.getTime() + wait * 60000)]);
    }

    // ───────── feedback ─────────
    const visitsForFeedback = await db.query<{ id: string; customerId: string; locationId: string; orgId: string }>(`SELECT id, customer_id, location_id, org_id FROM visits WHERE org_id=$1 AND customer_id IS NOT NULL AND left_at IS NOT NULL ORDER BY random() LIMIT 24`, [org.id]);
    const comments = ["Service impeccable, la pastilla était incroyable.", "Très belle ambiance, un peu bruyant côté terrasse.", "Attente un peu longue pour l'addition.", "Notre anniversaire était parfait, merci à toute l'équipe !", "Excellent rapport qualité-prix.", "Great rooftop views and friendly staff."];
    for (const v of visitsForFeedback) {
      const rating = chance(0.75) ? pick([5, 5, 4]) : pick([3, 2, 4]);
      await db.exec(`INSERT INTO feedback (org_id, location_id, customer_id, visit_id, token_hash, rating, comment, requested_at, submitted_at) VALUES ($1,$2,$3,$4,$5,$6,$7, now() - interval '3 days', now() - interval '2 days')`,
        [v.orgId, v.locationId, v.customerId, v.id, shortCode(24) + v.id, rating, chance(0.7) ? pick(comments) : null]);
    }
    await db.exec(`UPDATE customers SET notes='Allergie sévère aux arachides — prévenir la cuisine.' WHERE id IN (SELECT id FROM customers WHERE org_id=$1 AND 'arachides' = ANY(allergies) LIMIT 2)`, [org.id]);

    // ───────── audit trail sample ─────────
    const ownerId = (await db.one<{ id: string }>(`SELECT id FROM users WHERE email='owner@atlas.demo'`)).id;
    for (const a of ["location.update", "table.create", "team.invite", "service.update", "template.save"]) {
      await db.exec(`INSERT INTO audit_logs (org_id, actor_user_id, actor_label, action, entity_type, metadata, created_at) VALUES ($1,$2,'owner@atlas.demo',$3,'seed','{"note":"demo data"}', now() - interval '1 day' * floor(random()*10))`, [org.id, ownerId, a]);
    }
    console.log(`seeded: ${customers.length} guests, ${resCount} reservations`);
  });

  // Offers, segments, campaigns and notifications go through the real pipeline (simulated delivery).
  const { withOrg } = await import("../src/lib/db");
  const { runDueJobs } = await import("../src/server/notifications/jobs");
  const { dispatchEvent } = await import("../src/server/automation/service");
  const orgRow = await withSystem((db) => db.one<{ id: string }>(`SELECT id FROM organizations WHERE slug='atlas-hospitality'`));
  await withOrg(orgRow.id, async (db) => {
    const owner = await db.one<{ id: string }>(`SELECT id FROM users WHERE email='owner@atlas.demo'`).catch(() => null);
    void owner;
    const seg1 = await db.one<{ id: string }>(`INSERT INTO segments (org_id, name, criteria) VALUES ($1,'Clients VIP','{"vip":true}') RETURNING id`, [orgRow.id]);
    await db.exec(`INSERT INTO segments (org_id, name, criteria) VALUES ($1,'Clients perdus (> 60 jours)','{"lapsedDays":60,"minVisits":2}')`, [orgRow.id]);
    await db.exec(`INSERT INTO segments (org_id, name, criteria) VALUES ($1,'Anniversaires du mois','{"birthdayWithinDays":30}')`, [orgRow.id]);
    await db.exec(`INSERT INTO segments (org_id, name, criteria) VALUES ($1,'Habitués (4+ visites)','{"minVisits":4}')`, [orgRow.id]);
    const offer = await db.one<{ id: string }>(`INSERT INTO offers (org_id, name, code, description, kind, valid_from, valid_to) VALUES ($1,'Dessert offert aux habitués','HABITUE','Un dessert signature offert pour toute réservation d''ici la fin du mois.','returning_guest', current_date, current_date + 30) RETURNING id`, [orgRow.id]);
    await db.exec(`INSERT INTO offers (org_id, name, code, description, kind) VALUES ($1,'Gâteau d''anniversaire','ANNIV','Gâteau et bougie offerts pour les anniversaires déclarés.','birthday')`, [orgRow.id]);
    await db.exec(`INSERT INTO campaigns (org_id, name, channel, segment_id, offer_id, subject, body, status) VALUES ($1,'Menu d''automne — habitués','email',$2,$3,'Notre menu d''automne vous attend','Bonjour {{guest_name}},\n\nNotre menu d''automne est arrivé chez {{restaurant}}. {{offer}}\n\nRéservez ici : {{booking_link}}','draft')`, [orgRow.id, seg1.id, offer.id]);
    const sent = await db.one<{ id: string }>(`INSERT INTO campaigns (org_id, name, channel, segment_id, subject, body, status) VALUES ($1,'Soirée Ramadan — rappel','email',$2,'Réservez votre table','Bonjour {{guest_name}}, nos soirées vous attendent : {{booking_link}}','sending') RETURNING id`,
      [orgRow.id, (await db.one<{ id: string }>(`SELECT id FROM segments WHERE org_id=$1 AND name='Habitués (4+ visites)'`, [orgRow.id])).id]);
    await db.exec(`INSERT INTO jobs (org_id, type, payload, idempotency_key) VALUES ($1,'send_campaign',$2,$3)`, [orgRow.id, JSON.stringify({ orgId: orgRow.id, campaignId: sent.id }), `campaign:${sent.id}`]);
    // confirmations for upcoming reservations through the automation engine
    const upcoming = await db.query<{ id: string; locationId: string }>(`SELECT id, location_id FROM reservations WHERE org_id=$1 AND start_at > now() AND status='confirmed' ORDER BY start_at LIMIT 25`, [orgRow.id]);
    for (const r of upcoming) await dispatchEvent(db, { type: "reservation_confirmed", orgId: orgRow.id, locationId: r.locationId, reservationId: r.id, version: "seed" });
  });
  for (let i = 0; i < 3; i++) await runDueJobs(100);
  console.log("\nDemo accounts (password for all: " + DEMO_PASSWORD + ")");
  console.log("  admin@fluentra.dev          Platform super administrator  → /admin");
  console.log("  owner@atlas.demo            Owner (Atlas Hospitality Group)");
  console.log("  gm@atlas.demo               General manager");
  console.log("  manager@atlas.demo          Restaurant manager (Le Riad Atlas only)");
  console.log("  host@atlas.demo             Host / receptionist (Le Riad Atlas only)");
  console.log("  service@atlas.demo          Service team (Le Riad Atlas only)");
  console.log("  marketing@atlas.demo        Marketing manager");
  console.log("  host.marrakech@atlas.demo   Host (Skyline Rooftop only)");
  console.log("  owner@medina.demo           Owner of a second, isolated tenant (Café Médina, Starter plan)");
  console.log("Public booking pages: /book/le-riad-atlas  /book/skyline-rooftop  /book/cafe-medina");
  void utcToLocal;
  if (!process.env.__SEED_KEEP_POOL) await closePool();
}

const direct = process.argv[1] && /seed\.(ts|js)$/.test(process.argv[1]);
if (direct) {
  seed({ force: process.argv.includes("--force") }).catch((e) => { console.error(e); process.exit(1); });
}
