import { requireUser } from "@/server/auth.ts";
import { handle, type IdCtx } from "@/server/http.ts";
import { getTripBundle } from "@/server/trips.ts";

export const GET = handle<IdCtx>(async (_req, { params }) => getTripBundle(await requireUser(), (await params).id));
