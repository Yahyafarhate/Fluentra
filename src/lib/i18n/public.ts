import { cookies } from "next/headers";
import { isLocale, LOCALE_COOKIE, type Locale } from "./index";

/** Public pages: the guest's explicit choice wins; otherwise the restaurant's language. */
export async function publicLocale(restaurantLocale: string | undefined): Promise<Locale> {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(c)) return c;
  return isLocale(restaurantLocale) ? restaurantLocale : "fr";
}
