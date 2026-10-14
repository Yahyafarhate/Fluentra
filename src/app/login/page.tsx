import { Suspense } from "react";
import type { Metadata } from "next";
import { LoginForm } from "./form";
import { env } from "@/lib/env";

export const metadata: Metadata = { title: "Log in" };
export default function Page() {
  return <Suspense><LoginForm showDemo={!env.isProd} /></Suspense>;
}
