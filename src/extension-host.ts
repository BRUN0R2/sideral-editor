import { Channel, invoke } from "@tauri-apps/api/core";
import type { HostHandshake, HostInstruction } from "./features/sideral-extensions/contracts";
import { ExtensionHostSupervisor } from "./features/sideral-extensions/host/supervisor";

const supervisor = new ExtensionHostSupervisor();
const channel = new Channel<HostInstruction>();
const pendingInstructions: HostInstruction[] = [];
let connected = false;
channel.onmessage = (instruction) => {
  if (connected) {
    supervisor.accept(instruction);
  } else {
    pendingInstructions.push(instruction);
  }
};

void invoke<HostHandshake>("connect_extension_host", { channel })
  .then((handshake) => {
    supervisor.connect(handshake);
    connected = true;
    for (const instruction of pendingInstructions.splice(0)) {
      supervisor.accept(instruction);
    }
  })
  .catch((error: unknown) => supervisor.reportFatal(error))
  .catch(() => undefined);

window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  void supervisor.reportFatal(event.reason).catch(() => undefined);
});

window.addEventListener("error", (event) => {
  event.preventDefault();
  void supervisor.reportFatal(event.error ?? new Error(event.message)).catch(() => undefined);
});
