"use client";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui";
import { api } from "@/lib/client/api";
export function LogoutButton() {
  const router = useRouter();
  return <Button onClick={async () => { await api.post("/api/auth/logout"); router.push("/login"); router.refresh(); }}>Log out</Button>;
}
