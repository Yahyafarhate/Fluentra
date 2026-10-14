import { authRouter } from "@/server/routes/auth";

export const dynamic = "force-dynamic";
export const GET = authRouter.handler;
export const POST = authRouter.handler;
export const PUT = authRouter.handler;
export const PATCH = authRouter.handler;
export const DELETE = authRouter.handler;
