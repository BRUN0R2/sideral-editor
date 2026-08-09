import type { ExtensionModule } from "@sideral/extension-sdk";

export const activate: ExtensionModule["activate"] = (context, api) => {
  const output = api.window.createOutputChannel("Hello Sideral");
  const command = api.commands.registerCommand("sideral.hello.greet", async () => {
    const previous = await api.storage.get("greetingCount");
    const count = typeof previous === "number" ? previous + 1 : 1;
    await api.storage.update("greetingCount", count);
    output.appendLine(`Greeting ${count} from ${context.extensionId}.`);
    output.show();
    await output.flush();
    await api.window.showInformationMessage(`Hello from Sideral — greeting ${count}.`);
    return { count };
  });
  context.subscriptions.add(output, command);
};
