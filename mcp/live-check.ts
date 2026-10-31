// Live check against real apps through the MCP protocol. Needs TextEdit allowed
// and Finder not allowed. Opens a new TextEdit document and leaves it open.
import { connect } from "./client";

const osa = (s: string) => Bun.spawnSync(["osascript", "-e", s]).stdout.toString().trim();
const front = () => osa('tell application "System Events" to name of first process whose frontmost is true');
const results: [string, boolean, string][] = [];
const check = (name: string, ok: boolean, detail = "") => results.push([name, ok, detail]);

const s = await connect();
const tools = (await s.rpc("tools/list")) as any;
check("tools/list", tools.tools.length === 9, `${tools.tools.length} tools`);

const finder = await s.tool("snapshot", { app: "Finder" });
check("Finder refused", finder.isError && finder.text.includes("not in the allow list"), finder.text.slice(0, 90));

osa('tell application "Claude" to activate'); Bun.sleepSync(800);
const frontBefore = front();
check("launch TextEdit", !(await s.tool("launch", { app: "TextEdit" })).isError);
osa('tell application "TextEdit" to make new document');
Bun.sleepSync(500);
const marker = `deos-hand ${Date.now()} שלום`;
const wins = JSON.parse((await s.tool("list_windows", { app: "TextEdit" })).text);
const win = wins.find((w: any) => /^Untitled/.test(w.title))?.id;
check("list_windows", !!win, `${wins.length} windows, using ${win}`);
const found = await s.tool("find", { app: "TextEdit", role: "textfield", first: true, window_id: win });
const ref = /@[^"\s]+:e\d+/.exec(found.text)?.[0];
check("find textarea", !found.isError && !!ref, ref ?? found.text.slice(0, 120));
if (ref) {
  const typed = await s.tool("act", { action: "type", ref, text: marker });
  check("type into ref", !typed.isError, typed.text.slice(0, 120));
  const body = osa('tell application "TextEdit" to text of document 1');
  check("text landed (read by AppleScript)", body.includes(marker), JSON.stringify(body.slice(0, 60)));
}
check("forged ref refused", (await s.tool("act", { action: "click", ref: "@sFORGED:e1" })).isError);
const shot = await s.tool("screenshot", { app: "TextEdit", window_id: win });
check("window screenshot", shot.image.length > 1000, `${shot.image.length} b64 chars`);
check("focus not stolen", front() === frontBefore, `${frontBefore} -> ${front()}`);
s.close();

for (const [n, ok, d] of results) console.log(`${ok ? "PASS" : "FAIL"}  ${n}${d ? `  (${d})` : ""}`);
process.exit(results.every((r) => r[1]) ? 0 : 1);
