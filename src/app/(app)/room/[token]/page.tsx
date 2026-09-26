"use client";

/**
 * Group Vibe Check room — public to link holders, no account needed.
 * Guests pick a name, vote yes/no on each of up to 3 real nearby eateries,
 * and see the live tally. A unanimous yes writes the choice into the trip.
 * The guest's participant key stays in this browser only (localStorage).
 */
import Link from "next/link";
import { use, useEffect, useState } from "react";
import { api } from "../../_components/api";
import { useLive } from "../../_components/useLive";

interface RoomView {
  destination: string;
  start: string;
  durationMinutes: number;
  options: { id: string; name: string; nameNative?: string; kind: string; diet: string; travelMinutes: number }[];
  participants: { id: string; name: string; voted: number }[];
  tally: Record<string, number>;
  state: "OPEN" | "WIN" | "DEADLOCK" | "DECIDED" | "CLOSED" | "EXPIRED";
  winnerOptionId?: string;
}
interface Creds {
  participantId: string;
  key: string;
  votes?: Record<string, "yes" | "no">;
}

const storageKey = (token: string) => `mz-room-${token}`;
const readCreds = (token: string): Creds | null => {
  try {
    const raw = localStorage.getItem(storageKey(token));
    return raw ? (JSON.parse(raw) as Creds) : null;
  } catch {
    return null;
  }
};
const writeCreds = (token: string, c: Creds) => {
  try {
    localStorage.setItem(storageKey(token), JSON.stringify(c));
  } catch {
    /* private mode: voting still works this session */
  }
};

export default function RoomPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = use(params);
  const { data, error } = useLive<RoomView>(`/api/rooms/${token}`, `/api/rooms/${token}/events`);
  const [creds, setCreds] = useState<Creds | null>(null);
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    const c = readCreds(token);
    if (c) queueMicrotask(() => setCreds(c));
  }, [token]);

  if (error && !data) return <main className="mz-shell"><p className="mz-error" style={{ paddingTop: 24 }}>{error}</p></main>;
  if (!data) return <main className="mz-shell"><p className="mz-muted" style={{ paddingTop: 24 }}>Opening the room…</p></main>;

  const winner = data.options.find((o) => o.id === data.winnerOptionId);
  const finished = data.state === "DECIDED" || data.state === "CLOSED" || data.state === "EXPIRED";

  async function vote(optionId: string, v: "yes" | "no") {
    if (!creds) return;
    setMsg(null);
    try {
      await api(`/api/rooms/${token}/vote`, { body: { participantId: creds.participantId, key: creds.key, optionId, vote: v } });
      const next = { ...creds, votes: { ...creds.votes, [optionId]: v } };
      setCreds(next);
      writeCreds(token, next);
    } catch (e) {
      setMsg((e as Error).message);
    }
  }

  return (
    <main className="mz-shell mz-stack" style={{ paddingTop: 24 }}>
      <div className="mz-spread">
        <Link href="/" className="mz-label">
          ← Home
        </Link>
        <span className="mz-label">Group vote · {data.destination}</span>
      </div>
      <h1 className="mz-display mz-h1">Where do we eat at {data.start}?</h1>
      <p className="mz-small mz-muted" style={{ margin: 0 }}>
        {data.participants.map((p) => p.name).join(", ")} · a place wins when everyone says yes.
      </p>

      {winner && (
        <div className="mz-card u-INFO" role="status">
          <span className="mz-label">It&apos;s decided</span>
          <h2 className="mz-display mz-h2">{winner.name}</h2>
          <p className="mz-small" style={{ margin: 0 }}>Added to the trip at {data.start}. Enjoy!</p>
        </div>
      )}
      {data.state === "EXPIRED" && !winner && <p className="mz-note">This vote has expired.</p>}
      {data.state === "DEADLOCK" && <p className="mz-note">Everyone voted but nothing is unanimous — the organiser will pick.</p>}

      {!creds && !finished && (
        <form
          className="mz-panel mz-stack"
          onSubmit={async (e) => {
            e.preventDefault();
            setMsg(null);
            try {
              const c = await api<Creds>(`/api/rooms/${token}/join`, { body: { name } });
              setCreds(c);
              writeCreds(token, c);
            } catch (err) {
              setMsg((err as Error).message);
            }
          }}
        >
          <label className="mz-field">
            <span className="mz-label">Your name</span>
            <input className="mz-input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} required />
          </label>
          <button className="mz-btn mz-btn-solid">Join the vote</button>
        </form>
      )}

      <div className="mz-stack">
        {data.options.map((o) => {
          const mine = creds?.votes?.[o.id];
          return (
            <article key={o.id} className={`mz-card${o.id === data.winnerOptionId ? " u-INFO" : ""}`}>
              <div className="mz-spread">
                <h3 className="mz-display mz-h3">{o.name}</h3>
                <span className="mz-tier t-AUTO">
                  {data.tally[o.id] ?? 0}/{data.participants.length} yes
                </span>
              </div>
              {o.nameNative && <p className="mz-small" style={{ margin: 0 }}>{o.nameNative}</p>}
              <p className="mz-tiny mz-muted" style={{ margin: 0 }}>
                {o.kind.replace("amenity=", "").replace("_", " ")} · ~{o.travelMinutes} min travel ·{" "}
                {o.diet === "verified" ? "fits the group's diet (OSM tags)" : o.diet === "unverified" ? "diet unverified" : "no diet needs"}
              </p>
              {data.state === "DEADLOCK" && (
                <button
                  className="mz-btn mz-btn-sm"
                  onClick={() =>
                    api(`/api/rooms/${token}/decide`, { body: { optionId: o.id } }).catch((e) => setMsg(e.status === 401 || e.status === 403 ? "Only the organiser (logged in) can pick." : e.message))
                  }
                >
                  Organiser: choose this
                </button>
              )}
              {creds && !finished && (
                <div className="mz-row">
                  <button className="mz-chip" aria-pressed={mine === "yes"} onClick={() => vote(o.id, "yes")}>
                    Yes
                  </button>
                  <button className="mz-chip" aria-pressed={mine === "no"} onClick={() => vote(o.id, "no")}>
                    No
                  </button>
                </div>
              )}
            </article>
          );
        })}
      </div>
      {msg && <p className="mz-error">{msg}</p>}
    </main>
  );
}
