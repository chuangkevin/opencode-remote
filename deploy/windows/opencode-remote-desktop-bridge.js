export async function OpenCodeRemoteDesktopBridge(input) {
  const { initializeDesktopBridge } = await import("../opencode-remote/opencode-remote-desktop-bridge-lib.js");
  return initializeDesktopBridge(input);
}
