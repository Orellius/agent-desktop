import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fake agent-desktop: logs each argv line and answers like the real CLI.
const root = mkdtempSync(join(tmpdir(), "deos-hand-test-"));
const settings = join(root, "settings");
const log = join(root, "calls.log");
const fake = join(root, "agent-desktop");
writeFileSync(
  fake,
  `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  list-apps) echo '{"ok":true,"data":{"apps":[{"name":"TextEdit","bundle_id":"com.apple.TextEdit","presentation":"regular"},{"name":"Finder","bundle_id":"com.apple.finder","presentation":"regular"}]}}' ;;
  snapshot) case "$*" in
    *menubar*) echo '{"ok":true,"data":{"snapshot_id":"sMB","tree":{"role":"menu","children":[{"role":"menuitem","name":"Apple","ref_id":"@sMB:e1","children":[{"role":"menuitem","name":"System Settings…","ref_id":"@sMB:e5"}]},{"role":"menuitem","name":"View","ref_id":"@sMB:e9"}]}}}' ;;
    *) echo '{"ok":true,"data":{"snapshot_id":"sNEW","tree":{"ref_id":"@sNEW:e1","role":"textarea"}}}' ;;
  esac ;;
  find) echo '{"ok":true,"data":{"matches":[{"ref_id":"@sFIND:e2"}]}}' ;;
  *) echo '{"ok":true,"data":{"done":"'"$1"'"}}' ;;
esac
`,
);
chmodSync(fake, 0o755);
process.env.AGENT_DESKTOP_BIN = fake;
process.env.DEOS_HAND_SETTINGS_DIR = settings;

const gate = await import("./gate");
const { call } = await import("./server");

const allow = (body: string) => {
  rmSync(settings, { recursive: true, force: true });
  require("node:fs").mkdirSync(settings, { recursive: true });
  writeFileSync(join(settings, "settings.json"), body);
};
const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
const textOf = (r: any) => r.content[0].text as string;

beforeEach(() => rmSync(log, { force: true }));
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("allow list", () => {
  test("missing file allows nothing", () => {
    rmSync(settings, { recursive: true, force: true });
    expect(() => gate.allowedApps()).toThrow(/no readable allow list/);
  });
  test("broken JSON allows nothing", () => {
    allow("{nope");
    expect(() => gate.allowedApps()).toThrow(/no readable allow list/);
  });
  test("wrong shape allows nothing", () => {
    allow('{"allowed_apps":"com.apple.TextEdit"}');
    expect(() => gate.allowedApps()).toThrow(/not a list/);
  });
  test("bundle ids compare lowercased", () => {
    allow('{"allowed_apps":["COM.APPLE.TEXTEDIT"]}');
    expect(() => gate.requireAllowed({ name: "TextEdit", bundle: "com.apple.TextEdit" })).not.toThrow();
  });
  test("refusal names request_access", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    expect(() => gate.requireAllowed({ name: "Finder", bundle: "com.apple.finder" })).toThrow(
      'Finder (com.apple.finder) is not in the allow list; call request_access with app "com.apple.finder" to ask Orel, then end your turn',
    );
  });
});

describe("request_access", () => {
  test("writes pending.json with sorted keys and leaves settings alone", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    const before = readFileSync(join(settings, "settings.json"), "utf8");
    const msg = gate.requestAccess({ name: "Finder", bundle: "com.apple.finder" }, new Date("2026-10-31T10:00:00Z"));
    expect(msg).toContain("Speedsnail asks Orel aloud");
    expect(readFileSync(join(settings, "pending.json"), "utf8")).toBe(
      '{"bundle":"com.apple.finder","name":"Finder","time":"2026-10-31T10:00:00.000Z"}',
    );
    expect(readFileSync(join(settings, "settings.json"), "utf8")).toBe(before);
  });
  test("already allowed requests nothing", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    expect(gate.requestAccess({ name: "TextEdit", bundle: "com.apple.TextEdit" })).toContain("already allowed");
    expect(existsSync(join(settings, "pending.json"))).toBe(false);
  });
});

describe("server gate", () => {
  test("snapshot of a refused app never reaches the CLI snapshot", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    const r = call("snapshot", { app: "Finder" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("not in the allow list");
    expect(calls().some((c) => c.startsWith("snapshot"))).toBe(false);
  });
  test("press and screenshot are gated too", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    expect(call("press", { app: "com.apple.finder", combo: "cmd+q" }).isError).toBe(true);
    expect(call("screenshot", { app: "Finder" }).isError).toBe(true);
    expect(calls().filter((c) => !c.startsWith("list-apps"))).toEqual([]);
  });
  test("ref from our snapshot works, forged ref is refused", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    expect(call("snapshot", { app: "TextEdit" }).isError).toBe(false);
    expect(calls().at(-1)).toBe("snapshot --app TextEdit --compact -i");
    const ok = call("act", { action: "type", ref: "@sNEW:e1", text: "שלום hi" });
    expect(ok.isError).toBe(false);
    expect(calls().at(-1)).toBe("type @sNEW:e1 שלום hi");
    const forged = call("act", { action: "click", ref: "@sOTHER:e1" });
    expect(forged.isError).toBe(true);
    expect(textOf(forged)).toContain("did not take");
  });
  test("refs from find are recorded", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    call("find", { app: "TextEdit", role: "button" });
    expect(call("act", { action: "click", ref: "@sFIND:e2" }).isError).toBe(false);
  });
  test("revoking the app kills its refs", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    call("snapshot", { app: "TextEdit" });
    allow('{"allowed_apps":[]}');
    const r = call("act", { action: "click", ref: "@sNEW:e1" });
    expect(r.isError).toBe(true);
    expect(calls().some((c) => c.startsWith("click"))).toBe(false);
  });
  test("unknown action and malformed ref are refused", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    expect(call("act", { action: "mouse-click", ref: "@sNEW:e1" }).isError).toBe(true);
    expect(call("act", { action: "click", ref: "sNEW:e1" }).isError).toBe(true);
  });
  test("Apple menu is cut from a menubar snapshot and its refs refused", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    const r = call("snapshot", { app: "TextEdit", surface: "menubar" });
    expect(textOf(r)).not.toContain("System Settings");
    expect(textOf(r)).toContain('"View"');
    expect(call("act", { action: "click", ref: "@sMB:e9" }).isError).toBe(false);
    const sys = call("act", { action: "click", ref: "@sMB:e5" });
    expect(sys.isError).toBe(true);
    expect(textOf(sys)).toContain("Apple menu");
    expect(calls().some((c) => c.includes("@sMB:e5"))).toBe(false);
  });
  test("list_apps marks allowed apps", () => {
    allow('{"allowed_apps":["com.apple.textedit"]}');
    const apps = JSON.parse(textOf(call("list_apps", {})));
    expect(apps).toEqual([
      { name: "TextEdit", bundle: "com.apple.TextEdit", allowed: true },
      { name: "Finder", bundle: "com.apple.finder", allowed: false },
    ]);
  });
});
