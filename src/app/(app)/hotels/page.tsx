import { HotelsView } from "../_components/Essentials";
import { gate } from "../_components/gate";
import { TopBar } from "../_components/TopBar";

export default async function HotelsPage() {
  const user = await gate("traveller", "/hotels");
  return (
    <>
      <TopBar name={user.name} role="traveller" home="/trip" guest={user.guest} />
      <main className="mz-shell" style={{ paddingTop: 32 }}>
        <HotelsView />
      </main>
    </>
  );
}
