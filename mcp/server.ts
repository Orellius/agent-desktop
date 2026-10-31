// Stdio MCP server over the agent-desktop CLI, gated by Ghostjack's allow list.
// The CLI's JSON envelope is the contract, so upstream changes stay cheap to take.
// Headless only: no --headed, so nothing moves the cursor or steals focus.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { allowedApps, GateError, RefOwners, requestAccess, requireAllowed, type App } from "./gate";

const BIN = process.env.AGENT_DESKTOP_BIN ?? "agent-desktop";

type Envelope = { ok: boolean; data?: any; error?: any };

export function cli(args: string[]): Envelope {
  const p = Bun.spawnSync([BIN, ...args], { stdout: "pipe", stderr: "pipe" });
  const out = p.stdout.toString().trim();
  try {
    return JSON.parse(out);
  } catch {
    return { ok: false, error: { code: "BAD_OUTPUT", message: (out || p.stderr.toString()).slice(0, 500) } };
  }
}

function sh(cmd: string[]): string {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return p.exitCode === 0 ? p.stdout.toString().trim() : "";
}

// Name, bundle id or .app path -> {name, bundle}. Running apps first, then
// Launch Services; neither lookup launches the app.
export function resolveApp(query: string): App {
  const q = query.trim().replace(/\/$/, "");
  if (!q) throw new GateError("app is empty");
  const lq = q.toLowerCase();
  const running: any[] = cli(["list-apps"]).data?.apps ?? [];
  const hit = running.find((a) => a.bundle_id?.toLowerCase() === lq || a.name?.toLowerCase() === lq);
  if (hit?.bundle_id) return { name: hit.name, bundle: hit.bundle_id };
  if (q.endsWith(".app")) {
    const bundle = sh(["mdls", "-raw", "-name", "kMDItemCFBundleIdentifier", q]);
    if (bundle && bundle !== "(null)") return { name: basename(q, ".app"), bundle };
  }
  if (/^[\w-]+(\.[\w-]+)+$/.test(q)) {
    const path = sh(["mdfind", `kMDItemCFBundleIdentifier == '${q.replace(/'/g, "")}'`]).split("\n")[0];
    if (path) return { name: basename(path, ".app"), bundle: q };
  }
  const bundle = sh(["osascript", "-e", `id of application ${JSON.stringify(q)}`]);
  if (bundle) return { name: q, bundle };
  throw new GateError(`no app called "${query}"; call list_apps`);
}

const refs = new RefOwners();

const str = (d: string) => ({ type: "string", description: d });
const appArg = { app: str("App name, bundle id or .app path") };
const REF_ACTIONS = [
  "click", "type", "set-value", "clear", "focus", "select", "toggle", "check", "uncheck",
  "expand", "collapse", "scroll", "scroll-to", "right-click", "get", "is",
] as const;

export const TOOLS = [
  { name: "list_apps", description: "Running GUI apps with bundle ids and whether each is allowed", inputSchema: { type: "object", properties: {} } },
  { name: "request_access", description: "Ask Orel (aloud, through Speedsnail) to allow an app. End your turn after calling it.", inputSchema: { type: "object", properties: appArg, required: ["app"] } },
  { name: "launch", description: "Launch an allowed app and wait for its process", inputSchema: { type: "object", properties: appArg, required: ["app"] } },
  { name: "list_windows", description: "Windows of an allowed app", inputSchema: { type: "object", properties: appArg, required: ["app"] } },
  {
    name: "snapshot",
    description: "Accessibility tree of an allowed app with @refs for act. Refs die with their snapshot; take a new one after the UI changes.",
    inputSchema: {
      type: "object",
      properties: {
        ...appArg,
        interactive_only: { type: "boolean", description: "Only interactive elements (default true)" },
        max_depth: { type: "number" },
        window_id: str("From list_windows, when the app has several windows"),
        surface: str("window (default), focused, menu, menubar, sheet, popover, alert"),
      },
      required: ["app"],
    },
  },
  {
    name: "find",
    description: "Search an allowed app's elements; returns refs for act",
    inputSchema: { type: "object", properties: { ...appArg, role: str("button, textfield ..."), name: str("Accessible name"), text: str("Text in name, value, title or description"), value: str("Current value"), first: { type: "boolean" }, window_id: str("From list_windows, when the app has several windows") }, required: ["app"] },
  },
  {
    name: "act",
    description: "Act on a ref from snapshot or find. text is the text for type, the value for set-value and select. property is for get (text, value, title, bounds, role, states) and is (visible, enabled, checked, focused, expanded, selected).",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string", enum: REF_ACTIONS }, ref: str("@<snapshot_id>:eN"), text: str("Text or value"), direction: str("up, down, left, right"), amount: { type: "number" }, property: str("For get and is") },
      required: ["action", "ref"],
    },
  },
  { name: "press", description: "Send a key combo (return, escape, cmd+n ...) to an allowed app without focusing it", inputSchema: { type: "object", properties: { ...appArg, combo: str("Key combo") }, required: ["app", "combo"] } },
  { name: "screenshot", description: "PNG of an allowed app's window (never the whole display)", inputSchema: { type: "object", properties: { ...appArg, window_id: str("From list_windows") }, required: ["app"] } },
];

function gated(appQuery: string): App {
  const app = resolveApp(appQuery);
  requireAllowed(app);
  return app;
}

const opt = (flag: string, v: unknown) => (v === undefined || v === null || v === "" ? [] : [flag, String(v)]);

export function call(name: string, a: any): { content: any[]; isError?: boolean } {
  const text = (v: unknown) => ({ content: [{ type: "text", text: typeof v === "string" ? v : JSON.stringify(v) }] });
  const env = (e: Envelope, app?: App) => {
    if (app && e.ok) refs.record(e.data, app);
    return { ...text(e.ok ? e.data : { error: e.error }), isError: !e.ok };
  };
  try {
    switch (name) {
      case "list_apps": {
        let allowed = new Set<string>();
        try {
          allowed = allowedApps();
        } catch {}
        const apps = (cli(["list-apps"]).data?.apps ?? [])
          .filter((x: any) => x.presentation !== "background")
          .map((x: any) => ({ name: x.name, bundle: x.bundle_id, allowed: allowed.has(String(x.bundle_id).toLowerCase()) }));
        return text(apps);
      }
      case "request_access":
        return text(requestAccess(resolveApp(a.app)));
      case "launch": {
        const app = gated(a.app);
        // The CLI's launch fails AMBIGUOUS_TARGET on a running app with several
        // windows; the process is already up, which is all launch promises.
        const running = (cli(["list-apps"]).data?.apps ?? []).some((x: any) => x.bundle_id?.toLowerCase() === app.bundle.toLowerCase());
        if (running) return text({ app: app.name, already_running: true });
        return env(cli(["launch", app.name]));
      }
      case "list_windows": {
        const app = gated(a.app);
        return env(cli(["list-windows", "--app", app.name]));
      }
      case "snapshot": {
        const app = gated(a.app);
        const args = ["snapshot", "--app", app.name, "--compact", ...opt("--max-depth", a.max_depth), ...opt("--window-id", a.window_id), ...opt("--surface", a.surface)];
        if (a.interactive_only !== false) args.push("-i");
        return env(cli(args), app);
      }
      case "find": {
        const app = gated(a.app);
        const args = ["find", "--app", app.name, ...opt("--role", a.role), ...opt("--name", a.name), ...opt("--text", a.text), ...opt("--value", a.value), ...opt("--window-id", a.window_id)];
        if (a.first) args.push("--first");
        return env(cli(args), app);
      }
      case "act": {
        if (!REF_ACTIONS.includes(a.action)) throw new GateError(`action must be one of ${REF_ACTIONS.join(", ")}`);
        const app = refs.appFor(String(a.ref));
        const args: string[] = [a.action, a.ref];
        if (["type", "set-value", "select"].includes(a.action)) {
          if (typeof a.text !== "string") throw new GateError(`${a.action} needs text`);
          args.push(a.text);
        }
        if (a.action === "scroll") args.push(...opt("--direction", a.direction), ...opt("--amount", a.amount));
        if (a.action === "get" || a.action === "is") args.push(...opt("--property", a.property));
        return env(cli(args), app);
      }
      case "press": {
        const app = gated(a.app);
        return env(cli(["press", String(a.combo), "--app", app.name]));
      }
      case "screenshot": {
        const app = gated(a.app);
        const dir = mkdtempSync(join(tmpdir(), "deos-hand-"));
        try {
          const path = join(dir, "shot.png");
          const e = cli(["screenshot", "--app", app.name, ...opt("--window-id", a.window_id), path]);
          if (!e.ok) return env(e);
          return { content: [{ type: "image", mimeType: "image/png", data: readFileSync(path).toString("base64") }] };
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
      default:
        return { ...text(`unknown tool ${name}`), isError: true };
    }
  } catch (err) {
    return { ...text(err instanceof GateError ? err.message : `internal error: ${String(err)}`), isError: true };
  }
}

// JSON-RPC over newline-delimited stdio.
async function main() {
  const send = (msg: object) => process.stdout.write(JSON.stringify(msg) + "\n");
  let buf = "";
  for await (const chunk of Bun.stdin.stream()) {
    buf += new TextDecoder().decode(chunk);
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let req: any;
      try {
        req = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        continue;
      }
      if (req.id === undefined) continue; // notification
      const reply = (result: object) => send({ jsonrpc: "2.0", id: req.id, result });
      switch (req.method) {
        case "initialize":
          reply({ protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "deos-hand", version: "0.1.0" } });
          break;
        case "tools/list":
          reply({ tools: TOOLS });
          break;
        case "tools/call":
          reply(call(req.params?.name, req.params?.arguments ?? {}));
          break;
        case "ping":
          reply({});
          break;
        default:
          send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `no method ${req.method}` } });
      }
    }
  }
}

if (import.meta.main) main();
