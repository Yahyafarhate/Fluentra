import { describe, it, expect } from "vitest";
import { fr } from "@/lib/i18n/fr";
import { DYNAMIC_KEYS, INDIRECT_KEYS } from "@/lib/i18n/dynamic-keys";
import { extractKeys } from "../scripts/i18n-extract";

describe("i18n", () => {
  const keys = [...new Set([...extractKeys(), ...DYNAMIC_KEYS, ...INDIRECT_KEYS])];
  it("every UI string has a French translation (100% coverage)", () => {
    expect(keys.filter((k) => !(k in fr))).toEqual([]);
  });
  it("translations are clean: no empty values, no stray whitespace in keys, placeholders preserved", () => {
    for (const [k, v] of Object.entries(fr)) {
      expect(v.trim(), k).not.toBe("");
      expect(k, `key "${k}"`).toBe(k.trim());
      expect((v.match(/\{\w+\}/g) ?? []).sort(), k).toEqual((k.match(/\{\w+\}/g) ?? []).sort());
    }
  });
  it("has no dead translations (every French key is used somewhere)", () => {
    expect(Object.keys(fr).filter((k) => !keys.includes(k))).toEqual([]);
  });
});
