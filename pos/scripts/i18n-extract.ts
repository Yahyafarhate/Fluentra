import fs from "node:fs";
import path from "node:path";

/** Collects every literal `t("...")` / `t('...')` key used in the UI source. */
export function extractKeys(root = "src"): string[] {
  const keys = new Set<string>();
  const walk = (dir: string) => {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, f.name);
      if (f.isDirectory()) { if (!/node_modules|\.next/.test(p)) walk(p); continue; }
      if (!/\.(tsx?|ts)$/.test(f.name) || /i18n[\\/](fr|dynamic-keys)\.ts$/.test(p)) continue;
      const src = fs.readFileSync(p, "utf8");
      for (const m of src.matchAll(/\bt\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`$]*`)\s*[,)]/g)) {
        keys.add(JSON.parse(m[1].startsWith("'") ? `"${m[1].slice(1, -1).replace(/"/g, '\\"')}"` : m[1].startsWith("`") ? `"${m[1].slice(1, -1)}"` : m[1]));
      }
    }
  };
  walk(root);
  return [...keys].sort();
}

if (process.argv[1] && /i18n-extract\.(ts|js)$/.test(process.argv[1])) {
  const keys = extractKeys();
  const src = fs.readFileSync("src/lib/i18n/fr.ts", "utf8");
  const missing = keys.filter((k) => !src.includes(JSON.stringify(k)));
  console.log(`${keys.length} keys, ${missing.length} missing in fr`);
  if (process.argv.includes("--print")) console.log(JSON.stringify(missing, null, 1));
}
