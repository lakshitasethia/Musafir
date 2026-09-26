import { PackagesView } from "../_components/Essentials";
import { gate } from "../_components/gate";
import { TopBar } from "../_components/TopBar";

export default async function PackagesPage() {
  const user = await gate("traveller", "/packages");
  return (
    <>
      <TopBar name={user.name} role="traveller" home="/trip" guest={user.guest} />
      <main className="mz-shell" style={{ paddingTop: 32 }}>
        <PackagesView />
      </main>
    </>
  );
}
