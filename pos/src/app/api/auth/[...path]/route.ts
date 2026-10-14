import { authRouter } from "@/server/routes/auth";

export const dynamic = "force-dynamic";
const h = authRouter.handler;
export { h as GET, h as POST, h as PUT, h as PATCH, h as DELETE };
