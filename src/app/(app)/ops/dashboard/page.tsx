import { Dashboard } from "../../_components/Dashboard";
import { gate } from "../../_components/gate";
import { TopBar } from "../../_components/TopBar";

export default async function OperatorDashboard() {
  const user = await gate("operator", "/ops/dashboard");
  return (
    <>
      <TopBar name={user.name} role="operator" home="/ops" />
      <main className="mz-shell">
        <Dashboard role="operator" />
      </main>
    </>
  );
}
