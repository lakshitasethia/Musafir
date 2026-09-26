import { Dashboard } from "../_components/Dashboard";
import { gate } from "../_components/gate";
import { TopBar } from "../_components/TopBar";

export default async function TravellerDashboard() {
  const user = await gate("traveller", "/dashboard");
  return (
    <>
      <TopBar name={user.name} role="traveller" home="/trip" guest={user.guest} />
      <main className="mz-shell">
        <Dashboard role="traveller" />
      </main>
    </>
  );
}
