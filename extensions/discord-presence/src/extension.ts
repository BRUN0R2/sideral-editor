import type { ExtensionModule } from "@sideral/extension-sdk";
import { PresenceController } from "./presence-controller";

const extension: ExtensionModule = {
  async activate(context, api) {
    const output = api.window.createOutputChannel("Discord Work Presence");
    const controller = new PresenceController(api, output);
    const contextSubscription = api.workspace.onDidChangeContext((workspaceContext) =>
      controller.contextChanged(workspaceContext),
    );
    const toggleCommand = api.commands.registerCommand("sideral.discord-presence.toggle", () =>
      controller.toggle(),
    );
    const refreshCommand = api.commands.registerCommand(
      "sideral.discord-presence.refresh",
      async () => {
        await controller.refresh();
      },
    );
    context.subscriptions.add(
      output,
      contextSubscription,
      toggleCommand,
      refreshCommand,
      controller,
    );
    await controller.initialize();
  },
};

export const activate = extension.activate;
