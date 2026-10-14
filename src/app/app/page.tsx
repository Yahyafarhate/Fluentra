import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCtx, SESSION_COOKIE } from "@/lib/auth";
import { can } from "@/lib/rbac";

export default async function Page() {
  const ctx = await getCtx((await cookies()).get(SESSION_COOKIE)?.value);
  if (!ctx) redirect("/login");
  if (can(ctx.role, "dashboard.view")) redirect("/app/dashboard");
  redirect("/app/reservations");
}
