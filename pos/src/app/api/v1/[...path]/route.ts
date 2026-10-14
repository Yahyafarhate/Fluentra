import { v1 } from "@/server/routes/v1";

export const dynamic = "force-dynamic";
const h = v1.handler;
export { h as GET, h as POST, h as PUT, h as PATCH, h as DELETE };
