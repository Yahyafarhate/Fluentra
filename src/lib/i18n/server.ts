import { cookies, headers } from "next/headers";
import { isLocale, LOCALE_COOKIE, type Locale } from "./index";

export async function getLocale(): Promise<Locale> {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(c)) return c;
  const al = (await headers()).get("accept-language")?.toLowerCase() ?? "";
  if (al.startsWith("ar")) return "ar";
  if (al.startsWith("en")) return "en";
  return "fr";
}
