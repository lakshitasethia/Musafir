import { FlightsView } from "../_components/Essentials";
import { gate } from "../_components/gate";
import { TopBar } from "../_components/TopBar";

export default async function FlightsPage() {
  const user = await gate("traveller", "/flights");
  return (
    <>
      <TopBar name={user.name} role="traveller" home="/trip" guest={user.guest} />
      <main className="mz-shell mz-mapped" style={{ paddingTop: 32 }}>
        <FlightsView />
      </main>
    </>
  );
}
