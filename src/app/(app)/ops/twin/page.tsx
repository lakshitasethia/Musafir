import { FleetTwin } from "../../_components/FleetTwin";
import { gate } from "../../_components/gate";
import { TopBar } from "../../_components/TopBar";

export default async function OperatorTwin() {
  const user = await gate("operator", "/ops/twin");
  return (
    <>
      <TopBar name={user.name} role="operator" home="/ops" />
      <main className="mz-shell">
        <FleetTwin />
      </main>
    </>
  );
}
