import { gate } from "../_components/gate";
import { OpsConsole } from "../_components/OpsConsole";
import { TopBar } from "../_components/TopBar";

export default async function OperatorHome() {
  const user = await gate("operator");
  return (
    <>
      <TopBar name={user.name} role="operator" home="/ops" />
      <main className="mz-shell">
        <OpsConsole />
      </main>
    </>
  );
}
