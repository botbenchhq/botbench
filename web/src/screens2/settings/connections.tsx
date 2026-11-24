import { Devices, Notifications } from "./devices.tsx";
import { PairedWorkbench } from "./paired.tsx";

/** Connections and peers: the paired workbench, the devices signed in to this workbench, and what it may tell this device. */
export function ConnectionsGroup({ onSignedOut }: { onSignedOut: () => void }) {
  return (
    <div className="grid items-start gap-8 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <PairedWorkbench onSignedOut={onSignedOut} />
      <div className="flex min-w-0 flex-col gap-8">
        <Devices onSignedOut={onSignedOut} />
        <Notifications onSignedOut={onSignedOut} />
      </div>
    </div>
  );
}
