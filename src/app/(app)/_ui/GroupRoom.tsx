/**
 * Group-room layout: who's on the trip and whether each person has seen the latest plan version.
 * Group rooms aren't in the data model yet (CLAUDE.md §9), so this takes the plainest possible props;
 * Aryan maps real data onto it when rooms land.
 */
export interface RoomMember {
  id: string;
  name: string;
  role: "traveller" | "operator";
  /** Plan version this member last saw; compared with `planVersion` to show "seen" vs "behind". */
  seenVersion: number | null;
  online: boolean;
}

export function GroupRoom({ members, planVersion, footer }: { members: RoomMember[]; planVersion: number; footer?: React.ReactNode }) {
  const behind = members.filter((m) => m.seenVersion !== planVersion).length;
  return (
    <section className="mz-room" aria-label="Group room">
      <div className="mz-spread">
        <span className="mz-label">
          {members.length} on this trip · plan v{planVersion}
        </span>
        <span className={`mz-tier ${behind ? "t-TRAVELLER" : "t-AUTO"}`}>{behind ? `${behind} behind` : "Everyone's current"}</span>
      </div>
      <ul className="mz-room-members">
        {members.map((m) => {
          const current = m.seenVersion === planVersion;
          return (
            <li key={m.id} className={`mz-room-member${m.online ? "" : " is-away"}`}>
              <span className="mz-room-avatar" aria-hidden="true">
                {m.name.trim().charAt(0) || "?"}
              </span>
              <span style={{ minWidth: 0 }}>
                <span className="mz-room-name">{m.name}</span>
                <span className="mz-tiny mz-muted" style={{ display: "block" }}>
                  {m.role} · {m.online ? "here now" : "away"}
                </span>
              </span>
              <span className="mz-tiny mz-muted mz-mono">{m.seenVersion === null ? "not opened" : current ? "seen latest" : `saw v${m.seenVersion}`}</span>
            </li>
          );
        })}
      </ul>
      {footer}
    </section>
  );
}
