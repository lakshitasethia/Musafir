/**
 * Group Vibe Check consensus (USP 5), pure.
 *
 * Rule:
 *  - An option WINS as soon as every current participant (at least
 *    MIN_PARTICIPANTS) has voted "yes" on it. With several unanimous options,
 *    the earliest-listed (best-ranked) wins.
 *  - If every participant has voted on every option and none is unanimous,
 *    the result is DEADLOCK: no automatic write; the organiser sees the tally.
 *  - Otherwise voting is OPEN.
 * Joining late re-opens unanimity: a new participant must also say yes.
 */
export const MIN_PARTICIPANTS = 2;

export type Vote = "yes" | "no";
export type Votes = Readonly<Record<string, Readonly<Record<string, Vote>>>>; // participantId → optionId → vote

export type Consensus =
  | { state: "OPEN"; tally: Record<string, number> }
  | { state: "WIN"; optionId: string; tally: Record<string, number> }
  | { state: "DEADLOCK"; tally: Record<string, number> };

export function consensus(optionIds: readonly string[], participantIds: readonly string[], votes: Votes): Consensus {
  const tally = Object.fromEntries(optionIds.map((o) => [o, participantIds.filter((p) => votes[p]?.[o] === "yes").length]));
  if (participantIds.length >= MIN_PARTICIPANTS) {
    const winner = optionIds.find((o) => tally[o] === participantIds.length);
    if (winner) return { state: "WIN", optionId: winner, tally };
    const allVoted = participantIds.every((p) => optionIds.every((o) => votes[p]?.[o] !== undefined));
    if (allVoted) return { state: "DEADLOCK", tally };
  }
  return { state: "OPEN", tally };
}
