/**
 * Route map for the printable itinerary: every stop plotted from its own
 * coordinates (no map tiles, so nothing to fetch and nothing to rate-limit),
 * one colour per day, numbered in visiting order, with a distance scale.
 * Presentational only: props in, SVG out.
 */

export interface MapStop {
  id: string;
  lat: number;
  lng: number;
  title: string;
  day: number; // 1-based
  order: number; // 1-based within the day
}

export const DAY_COLORS = ["#3d2d20", "#4b6b94", "#5e8b72", "#c98a45", "#b8534f", "#7c6a96", "#2f7c86"];
export const dayColor = (day: number) => DAY_COLORS[(day - 1) % DAY_COLORS.length];

const W = 1000;
const H = 520;
const PAD = 70;
const KM_PER_DEG_LAT = 111.32;
const NICE_KM = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000];

export function ItineraryMap({ stops }: { stops: MapStop[] }) {
  if (stops.length === 0) return null;
  const lats = stops.map((s) => s.lat);
  const lngs = stops.map((s) => s.lng);
  const midLat = (Math.min(...lats) + Math.max(...lats)) / 2;
  const kx = Math.cos((midLat * Math.PI) / 180); // shrink longitude so shapes aren't stretched
  const xs = lngs.map((l) => l * kx);
  // Pad tiny extents (a single stop, or stops a street apart) to ~600 m.
  const minSpan = 0.006;
  let [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...lats), Math.max(...lats)];
  if (x1 - x0 < minSpan) [x0, x1] = [(x0 + x1) / 2 - minSpan / 2, (x0 + x1) / 2 + minSpan / 2];
  if (y1 - y0 < minSpan) [y0, y1] = [(y0 + y1) / 2 - minSpan / 2, (y0 + y1) / 2 + minSpan / 2];
  const scale = Math.min((W - PAD * 2) / (x1 - x0), (H - PAD * 2) / (y1 - y0));
  const ox = (W - (x1 - x0) * scale) / 2;
  const oy = (H - (y1 - y0) * scale) / 2;
  const at = (s: MapStop) => ({ x: ox + (s.lng * kx - x0) * scale, y: oy + (y1 - s.lat) * scale });

  // Scale bar: the largest "nice" distance that stays under ~180 px.
  const pxPerKm = scale / KM_PER_DEG_LAT;
  const km = [...NICE_KM].reverse().find((d) => d * pxPerKm <= 180) ?? NICE_KM[0];
  const bar = km * pxPerKm;

  const days = [...new Set(stops.map((s) => s.day))].sort((a, b) => a - b);
  const byDay = days.map((d) => stops.filter((s) => s.day === d).sort((a, b) => a.order - b.order));

  return (
    <svg className="mz-print-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Map of the itinerary's stops by day">
      <defs>
        <pattern id="mz-print-grid" width="40" height="40" patternUnits="userSpaceOnUse">
          <path d="M40 0H0V40" fill="none" stroke="#c2c6ca" strokeOpacity="0.35" strokeWidth="1" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="#fbf8f3" />
      <rect width={W} height={H} fill="url(#mz-print-grid)" />

      {byDay.map((ss, i) => (
        <polyline
          key={`route-${days[i]}`}
          points={ss.map((s) => `${at(s).x},${at(s).y}`).join(" ")}
          fill="none"
          stroke={dayColor(days[i])}
          strokeWidth={5}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={i === 0 ? undefined : "8 6"}
          opacity={0.75}
        />
      ))}

      {byDay.flat().map((s, i, all) => {
        // Stops a few metres apart would hide each other's numbers: step the
        // later marker aside (the route line still ends at the true spot).
        const p = { ...at(s) };
        for (const prev of all.slice(0, i)) {
          const q = at(prev);
          if (Math.hypot(p.x - q.x, p.y - q.y) < 36) {
            p.x += 30;
            p.y -= 22;
          }
        }
        return (
          <g key={s.id} transform={`translate(${p.x},${p.y})`}>
            <circle r={21} fill={dayColor(s.day)} stroke="#fbf8f3" strokeWidth={4} />
            <text y={7} textAnchor="middle" className="mz-print-map-num">
              {s.order}
            </text>
          </g>
        );
      })}

      <g transform={`translate(${W - PAD - bar},${H - 24})`}>
        <line x1={0} x2={bar} y1={0} y2={0} stroke="#3d2d20" strokeWidth={2} />
        <line x1={0} x2={0} y1={-6} y2={6} stroke="#3d2d20" strokeWidth={2} />
        <line x1={bar} x2={bar} y1={-6} y2={6} stroke="#3d2d20" strokeWidth={2} />
        <text x={bar / 2} y={-10} textAnchor="middle" className="mz-print-map-scale">
          {km < 1 ? `${km * 1000} m` : `${km} km`}
        </text>
      </g>
      <text x={PAD - 30} y={30} className="mz-print-map-scale">
        N ↑
      </text>
    </svg>
  );
}
