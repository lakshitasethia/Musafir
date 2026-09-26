import { PackagesView } from "./PackagesView";
import { gate } from "../../_components/gate";
import { TopBar } from "../../_components/TopBar";

export default async function PackagesPage() {
  const user = await gate("traveller", "/group/packages");
  return (
    <>
      <TopBar name={user.name} role="traveller" home="/trip" guest={user.guest} />
      <main className="mz-shell mz-mapped" style={{ paddingTop: 32 }}>
        <PackagesView />
      </main>
    </>
  );
}
