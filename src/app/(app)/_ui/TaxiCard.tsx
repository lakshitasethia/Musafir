import type { ItineraryNode } from "@/lib/musafir/schemas.ts";

/** Native scripts get long fast; past this many characters the headline steps down a size. */
const LONG_NATIVE_CHARS = 14;

/**
 * Boarding-pass card a traveller turns to face a driver: the destination in huge native script,
 * the native address below it, and a perforated stub with the Latin name and coordinates.
 * Nothing is invented — if there's no native name, the Latin title is shown and labelled as such.
 */
export function TaxiCard({
  node,
  lang,
}: {
  node: Pick<ItineraryNode, "title" | "nativeTitle" | "nativeAddress" | "location" | "timeSlot">;
  /** BCP 47 tag for the native script, so screen readers and fonts pick the right shaping. */
  lang?: string;
}) {
  const native = node.nativeTitle?.trim();
  const headline = native || node.title;
  const place = [node.location.neighborhood, node.location.city].filter(Boolean).join(", ");
  return (
    <article className="mz-taxi" aria-label={`Show to driver: ${node.title}`}>
      <div className="mz-taxi-head">
        <span className="mz-label">Please take me to</span>
        <span className="mz-label mz-mono">{node.timeSlot.start}</span>
      </div>
      <div className="mz-taxi-body">
        <p className="mz-taxi-native" lang={native ? lang : undefined} data-long={headline.length > LONG_NATIVE_CHARS}>
          {headline}
        </p>
        {node.nativeAddress && (
          <p className="mz-taxi-address" lang={lang}>
            {node.nativeAddress}
          </p>
        )}
        {!native && <p className="mz-tiny mz-muted" style={{ margin: 0 }}>No local-script name on record — showing the English name.</p>}
      </div>
      <dl className="mz-taxi-stub">
        <div>
          <dt>Destination</dt>
          <dd>{node.title}</dd>
        </div>
        {place && (
          <div>
            <dt>Area</dt>
            <dd>{place}</dd>
          </div>
        )}
        <div>
          <dt>Coordinates</dt>
          <dd>
            {node.location.lat.toFixed(5)}, {node.location.lng.toFixed(5)}
          </dd>
        </div>
      </dl>
    </article>
  );
}
