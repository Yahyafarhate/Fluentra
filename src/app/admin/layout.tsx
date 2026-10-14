import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { AdminShell } from "./shell";

export const dynamic = "force-dynamic";

export default async function Layout({ children }: { children: ReactNode }) {
  const s = await getSessionUser((await cookies()).get(SESSION_COOKIE)?.value);
  if (!s) redirect("/login");
  if (!s.user.isSuperAdmin) redirect("/app");
  return <AdminShell name={s.user.name}>{children}</AdminShell>;
}
