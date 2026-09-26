import { gate } from "../_components/gate";
import { TopBar } from "../_components/TopBar";
import { TripList } from "../_components/TripList";

export default async function TravellerHome() {
  const user = await gate("traveller");
  return (
    <>
      <TopBar name={user.name} role="traveller" home="/trip" />
      <main className="mz-shell">
        <div className="mz-page-head">
          <h1 className="mz-display mz-h1">Your journeys</h1>
          <p className="mz-small mz-muted" style={{ margin: 0 }}>
            Plan each day as a living graph. When plans break, Musafir heals them — you just tap.
          </p>
        </div>
        <TripList />
      </main>
    </>
  );
}
