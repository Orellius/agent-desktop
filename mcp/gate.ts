// Allow-list gate shared with Ghostjack: same settings.json, same pending.json,
// same messages, so Orel's grants and Speedsnail's voice approval keep working.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const settingsDir = () =>
  process.env.DEOS_HAND_SETTINGS_DIR ?? join(homedir(), "Library/Application Support/Backdrive");

export class GateError extends Error {}

const HINT = '{"allowed_apps": ["com.apple.calculator"]}';

// Re-read on every call, like Ghostjack: a grant takes effect without a restart.
// A missing or broken file allows no app.
export function allowedApps(): Set<string> {
  const path = join(settingsDir(), "settings.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new GateError(`no readable allow list at ${path}; write ${HINT} there`);
  }
  const list = (raw as { allowed_apps?: unknown })?.allowed_apps;
  if (!Array.isArray(list) || !list.every((b) => typeof b === "string"))
    throw new GateError(`allowed_apps in ${path} is not a list of bundle ids; write ${HINT}`);
  return new Set(list.map((b) => b.toLowerCase()));
}

export type App = { name: string; bundle: string };

export function requireAllowed(app: App) {
  if (!allowedApps().has(app.bundle.toLowerCase()))
    throw new GateError(
      `${app.name} (${app.bundle}) is not in the allow list; call request_access with app "${app.bundle}" to ask Orel, then end your turn`,
    );
}

// Writes pending.json for Speedsnail; never touches the allow list itself.
export function requestAccess(app: App, now = new Date()): string {
  let allowed = false;
  try {
    allowed = allowedApps().has(app.bundle.toLowerCase());
  } catch {}
  if (allowed) return `${app.name} (${app.bundle}) is already allowed; nothing was requested`;
  const dir = settingsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const body = { bundle: app.bundle, name: app.name, time: now.toISOString() };
  writeFileSync(join(dir, "pending.json"), JSON.stringify(body, Object.keys(body).sort()));
  return `access to ${app.name} (${app.bundle}) is requested. Speedsnail asks Orel aloud when your turn ends; end your turn now with no question of your own. His answer comes back as your next message.`;
}

// Refs look like @<snapshot_id>:eN. A ref is honoured only when this server made
// its snapshot, and only while that snapshot's app is still allowed.
export class RefOwners {
  private owners = new Map<string, App>();
  private denied = new Set<string>();

  // The Apple menu rides along in every app's menu bar and reaches System
  // Settings, Recent Items and other apps, so it would get around the
  // per-app gate. Its subtree is cut from the output and its refs refused.
  record(output: unknown, app: App) {
    cutAppleMenu(output, (ref) => this.denied.add(ref));
    walk(output, (id) => this.owners.set(id, app));
  }

  appFor(ref: string): App {
    const m = /^@([^:\s]+):e\d+$/.exec(ref);
    if (!m) throw new GateError(`"${ref}" is not a ref; take one from snapshot or find (@<snapshot_id>:eN)`);
    if (this.denied.has(ref)) throw new GateError(`ref ${ref} is in the Apple menu, which is outside any app's grant`);
    const app = this.owners.get(m[1]);
    if (!app) throw new GateError(`ref ${ref} is from a snapshot this server did not take; call snapshot first`);
    requireAllowed(app);
    return app;
  }
}

function walk(v: unknown, found: (id: string) => void) {
  if (Array.isArray(v)) return v.forEach((x) => walk(x, found));
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) {
      if (k === "snapshot_id" && typeof x === "string") found(x);
      else if (k === "ref_id" && typeof x === "string") {
        const m = /^@([^:\s]+):/.exec(x);
        if (m) found(m[1]);
      } else walk(x, found);
    }
}

function cutAppleMenu(v: unknown, deny: (ref: string) => void) {
  if (Array.isArray(v)) {
    for (let i = v.length - 1; i >= 0; i--) {
      const n = v[i] as any;
      if (n && n.role === "menuitem" && n.name === "Apple") {
        refsIn(n, deny);
        v.splice(i, 1);
      } else cutAppleMenu(n, deny);
    }
  } else if (v && typeof v === "object") for (const x of Object.values(v)) cutAppleMenu(x, deny);
}

function refsIn(v: unknown, found: (ref: string) => void) {
  if (Array.isArray(v)) return v.forEach((x) => refsIn(x, found));
  if (v && typeof v === "object")
    for (const [k, x] of Object.entries(v)) k === "ref_id" && typeof x === "string" ? found(x) : refsIn(x, found);
}
