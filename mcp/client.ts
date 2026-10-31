// Minimal MCP stdio client for live checks: spawns server.ts and calls tools.
import { join } from "node:path";

export async function connect() {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "server.ts")], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  const reader = proc.stdout.getReader();
  let buf = "";
  let id = 0;
  const rpc = async (method: string, params: object = {}) => {
    const my = ++id;
    proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: my, method, params }) + "\n");
    for (;;) {
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.id === my) return msg.result ?? msg;
        continue;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("server closed");
      buf += new TextDecoder().decode(value);
    }
  };
  await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "live-check", version: "0" } });
  const tool = async (name: string, args: object = {}) => {
    const r: any = await rpc("tools/call", { name, arguments: args });
    const c = r.content?.[0];
    return { isError: !!r.isError, text: c?.type === "text" ? c.text : "", image: c?.type === "image" ? c.data : "" };
  };
  return { rpc, tool, close: () => proc.kill() };
}
