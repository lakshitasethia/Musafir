import { requireUser } from "@/server/auth.ts";
import { handle, type IdCtx } from "@/server/http.ts";
import { roomsForTrip } from "@/server/rooms.ts";

export const GET = handle<IdCtx>(async (_req, { params }) => ({ rooms: await roomsForTrip(await requireUser(), (await params).id) }));
