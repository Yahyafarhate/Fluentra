import type { ReactNode } from "react";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCtx, getSessionUser, SESSION_COOKIE } from "@/lib/auth";
import { buildMe } from "@/server/me";
import { AppShell } from "@/components/app-shell";
import { Logo } from "@/components/icons";
import { LogoutButton } from "./logout-button";

export const dynamic = "force-dynamic";

export default async function Layout({ children }: { children: ReactNode }) {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const ctx = await getCtx(token);
  if (!ctx) {
    const s = await getSessionUser(token);
    if (s?.user.isSuperAdmin) redirect("/admin");
    redirect("/login");
  }
  if (ctx.org.status === "suspended" || ctx.org.status === "cancelled") {
    return (
      <main className="min-h-dvh grid place-items-center p-6 text-center">
        <div className="max-w-md space-y-4"><Logo /><h1 className="text-2xl font-semibold">Account suspended</h1>
          <p className="text-muted">Access to <b>{ctx.org.name}</b> is paused. Your data is safe and untouched. Please contact Fluentra support to reactivate the account.</p><LogoutButton /></div>
      </main>
    );
  }
  const me = await buildMe(ctx);
  return <AppShell me={me}>{children}</AppShell>;
}
