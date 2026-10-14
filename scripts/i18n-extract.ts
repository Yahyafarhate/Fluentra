/** Lists every translatable string (t("…") calls) and reports FR/AR coverage. Usage: npx tsx scripts/i18n-extract.ts [--missing fr|ar] [--json] */
import fs from "node:fs";
import path from "node:path";
import { fr } from "../src/lib/i18n/fr";
import { ar } from "../src/lib/i18n/ar";
import { DYNAMIC_KEYS } from "../src/lib/i18n/dynamic-keys";

function walk(dir: string, out: string[] = []) {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (f.name === "admin" || f.name === "api") continue; walk(p, out); } else if (/\.tsx?$/.test(f.name)) out.push(p);
  }
  return out;
}
const keys = new Set<string>();
const re = /\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)/g;
for (const file of [...walk("src/app"), ...walk("src/components")]) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(re)) { try { keys.add(JSON.parse(m[1].startsWith('"') ? m[1] : '"' + m[1].slice(1, -1).replace(/"/g, '\\"') + '"')); } catch { /* skip */ } }
}
// strings used through data tables (label maps) are listed explicitly by the extractor via the `t(` wrappers above
for (const k of DYNAMIC_KEYS) keys.add(k);
const all = [...keys].sort();
const miss = (d: Record<string, string>) => all.filter((k) => !d[k]);
const arg = process.argv.indexOf("--missing");
if (arg > -1) { const l = process.argv[arg + 1]; const m = miss(l === "ar" ? ar : fr); console.log(process.argv.includes("--json") ? JSON.stringify(m, null, 1) : m.join("\n")); process.exit(0); }
console.log(`strings: ${all.length}  fr: ${all.length - miss(fr).length} (${Math.round(100 * (1 - miss(fr).length / all.length))}%)  ar: ${all.length - miss(ar).length} (${Math.round(100 * (1 - miss(ar).length / all.length))}%)`);
