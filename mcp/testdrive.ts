// Test drive: the same laps driven by two computer-use tools, judged by a
// neutral referee (AppleScript / System Events), never by the tool under test.
//
//   bun testdrive.ts prep <lap>                    reset the app, put Claude in front, start the clock
//   bun testdrive.ts check <tool> <lap> <calls> [note]   referee the end state, stop the clock, log
//   bun testdrive.ts report                         table of every logged lap
//
// Laps: text (Hebrew+English into a new TextEdit doc), mini (same, window minimized), calc (127×49 by buttons),
// menu (Calculator View > Scientific through the menu bar).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = join(import.meta.dir, "..", "docs", "testdrive");
mkdirSync(dir, { recursive: true });
const clock = join(dir, "clock.json");
const log = join(dir, "results.jsonl");

export const TEXT = "נסיעת מבחן 42: hello עולם";
const CALC_WANT = "6223";
// The display is the last static text in a scroll area (history rows come first).
// System Events prints references as text; read the names from that.
const calcDisplay = () => {
  const all = sysev("Calculator", "get entire contents of window 1");
  const hits = [...all.matchAll(/static text (.*?) of scroll area \d+/gs)].map((m) => m[1]);
  return hits.at(-1) ?? `no display in: ${all.slice(0, 80)}`;
};

const osa = (s: string) => {
  const p = Bun.spawnSync(["osascript", "-e", s], { stderr: "pipe" });
  return p.stdout.toString().trim() || p.stderr.toString().trim();
};
const sysev = (proc: string, body: string) => osa(`tell application "System Events" to tell process "${proc}" to ${body}`);
const front = () => osa('tell application "System Events" to name of first process whose frontmost is true');
const claudeFront = () => {
  osa('tell application "Claude" to activate');
  Bun.sleepSync(700);
};

// The document a text lap made, by name: "document 1" shifts once a window is minimized.
const target = join(dir, "target-doc");
const newDoc = () => {
  osa('tell application "TextEdit" to make new document');
  Bun.sleepSync(500);
  const name = osa('tell application "TextEdit" to name of document 1');
  writeFileSync(target, name);
  return name;
};
const doc = () => JSON.stringify(readFileSync(target, "utf8"));

const laps: Record<string, { prep: () => void; check: () => [boolean, string] }> = {
  text: {
    prep: () => {
      newDoc();
    },
    check: () => {
      const body = osa(`tell application "TextEdit" to text of document ${doc()}`);
      return [body === TEXT, `${doc()}: ${JSON.stringify(body)}`];
    },
  },
  mini: {
    prep: () => {
      const name = newDoc();
      osa(`tell application "TextEdit" to set miniaturized of window ${JSON.stringify(name)} to true`);
      Bun.sleepSync(800);
    },
    check: () => {
      const body = osa(`tell application "TextEdit" to text of document ${doc()}`);
      const mini = osa(`tell application "TextEdit" to miniaturized of window ${doc()}`);
      return [body === TEXT && mini === "true", `${doc()}: ${JSON.stringify(body)} minimized=${mini}`];
    },
  },
  calc: {
    prep: () => {
      osa('tell application "Calculator" to launch');
      Bun.sleepSync(500);
      sysev("Calculator", 'click menu item "Basic" of menu "View" of menu bar 1');
      osa('tell application "Calculator" to activate');
      Bun.sleepSync(300);
      osa('tell application "System Events" to key code 53'); // escape = clear
      Bun.sleepSync(200);
    },
    check: () => {
      const shown = calcDisplay();
      return [shown.replace(/[^\d.-]/g, "") === CALC_WANT, shown.replace(/[‎‏]/g, "")];
    },
  },
  menu: {
    prep: () => {
      osa('tell application "Calculator" to launch');
      Bun.sleepSync(500);
      sysev("Calculator", 'click menu item "Basic" of menu "View" of menu bar 1');
      Bun.sleepSync(300);
    },
    check: () => {
      const size = sysev("Calculator", "get size of window 1");
      const w = Number(size.split(",")[0]);
      return [w > 300, `window ${size}`];
    },
  },
};

const [cmd, a, b, c, ...note] = process.argv.slice(2);
if (cmd === "prep") {
  const lap = laps[a];
  if (!lap) throw new Error(`lap must be one of ${Object.keys(laps)}`);
  lap.prep();
  claudeFront();
  writeFileSync(clock, JSON.stringify({ lap: a, start: Date.now(), front: front() }));
  console.log(`prepped ${a}; front=${front()}; clock running`);
} else if (cmd === "check") {
  const [tool, lapName, calls] = [a, b, Number(c)];
  const t = existsSync(clock) ? JSON.parse(readFileSync(clock, "utf8")) : null;
  if (!t || t.lap !== lapName) throw new Error(`no clock for ${lapName}; run prep first`);
  const [pass, seen] = laps[lapName].check();
  const row = {
    tool, lap: lapName, pass, seen, calls,
    seconds: Math.round((Date.now() - t.start) / 100) / 10,
    focus_kept: front() === t.front, front_after: front(),
    note: note.join(" "), at: new Date().toISOString(),
  };
  appendFileSync(log, JSON.stringify(row) + "\n");
  console.log(JSON.stringify(row));
} else if (cmd === "report") {
  const rows = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  console.log("tool            lap    pass  calls  sec    focus  note");
  for (const r of rows)
    console.log(`${r.tool.padEnd(15)} ${r.lap.padEnd(6)} ${String(r.pass).padEnd(5)} ${String(r.calls).padEnd(6)} ${String(r.seconds).padEnd(6)} ${String(r.focus_kept).padEnd(6)} ${r.note}`);
} else {
  console.log("usage: prep <lap> | check <tool> <lap> <calls> [note] | report");
}
