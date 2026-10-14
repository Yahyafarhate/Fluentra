import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fr, ar, translate, dirOf } from "@/lib/i18n";
import { DYNAMIC_KEYS } from "@/lib/i18n/dynamic-keys";

function sources(dir: string, out: string[] = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name !== "admin" && f.name !== "api") sources(p, out); } else if (/\.tsx?$/.test(f.name)) out.push(p);
  }
  return out;
}
const keys = new Set<string>(DYNAMIC_KEYS);
const re = /\bt\(\s*"((?:[^"\\]|\\.)*)"/g;
for (const f of [...sources("src/app"), ...sources("src/components")]) for (const m of fs.readFileSync(f, "utf8").matchAll(re)) keys.add(JSON.parse(`"${m[1]}"`));

const vars = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");

describe("i18n", () => {
  it("translates every user-facing string into French and Arabic", () => {
    const missingFr = [...keys].filter((k) => !fr[k]);
    const missingAr = [...keys].filter((k) => !ar[k]);
    expect(missingFr).toEqual([]);
    expect(missingAr).toEqual([]);
  });
  it("keeps interpolation placeholders intact in every translation", () => {
    const bad: string[] = [];
    for (const [k, v] of [...Object.entries(fr).map(([k, v]) => [k, v, "fr"] as const), ...Object.entries(ar).map(([k, v]) => [k, v, "ar"] as const)]) {
      if (vars(k) !== vars(v)) bad.push(`${v.length ? "" : "EMPTY "}${k} -> ${v}`);
    }
    expect(bad).toEqual([]);
  });
  it("has no stale dictionary entries", () => {
    expect(Object.keys(fr).filter((k) => !keys.has(k))).toEqual([]);
    expect(Object.keys(ar).filter((k) => !keys.has(k))).toEqual([]);
  });
  it("interpolates and falls back to English", () => {
    expect(translate("fr", "Trial: {n} days left", { n: 5 })).toBe("Essai : 5 jours restants");
    expect(translate("ar", "Trial ends {date}", { date: "x" })).toContain("x");
    expect(translate("en", "Unknown string {a}", { a: 1 })).toBe("Unknown string 1");
    expect(translate("fr", "Not in dictionary")).toBe("Not in dictionary");
  });
  it("uses right-to-left layout for Arabic only", () => {
    expect([dirOf("ar"), dirOf("fr"), dirOf("en")]).toEqual(["rtl", "ltr", "ltr"]);
  });
});
