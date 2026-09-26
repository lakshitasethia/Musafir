import { gate } from "../../../_components/gate";
import { TopBar } from "../../../_components/TopBar";
import { Workspace } from "../../../_components/Workspace";

export default async function OperatorTrip({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await gate("operator", `/ops/trips/${id}`);
  return (
    <>
      <TopBar name={user.name} role="operator" home="/ops" />
      <main className="mz-shell">
        <Workspace tripId={id} role="operator" backHref="/ops" />
      </main>
    </>
  );
}
