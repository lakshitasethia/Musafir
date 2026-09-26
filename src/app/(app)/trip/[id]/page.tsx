import { gate } from "../../_components/gate";
import { TopBar } from "../../_components/TopBar";
import { Workspace } from "../../_components/Workspace";

export default async function TravellerTrip({ params }: { params: Promise<{ id: string }> }) {
  const user = await gate("traveller");
  const { id } = await params;
  return (
    <>
      <TopBar name={user.name} role="traveller" home="/trip" />
      <main className="mz-shell">
        <Workspace tripId={id} role="traveller" backHref="/trip" />
      </main>
    </>
  );
}
