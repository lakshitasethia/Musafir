import { requireUser } from "@/server/auth.ts";
import { handle } from "@/server/http.ts";

/** GET /api/auth/me — who the session belongs to (used by the WhatsApp service to verify a link). */
export const GET = handle(async () => ({ user: await requireUser() }));
