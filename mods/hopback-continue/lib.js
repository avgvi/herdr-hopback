// Helpers shared by the hopback pop-up (mods/hopback) and quick continue (mods/hopback-continue).
// Herdr doesn't let a mod import from another mod's folder, so each has this same file:
// change both copies together.

import { exec, run, spaces, panes, terminals, home, notify } from "herdr";

export const NAMES = {
  claude: "Claude Code", codex: "Codex", antigravity: "Antigravity", opencode: "OpenCode", kimi: "Kimi Code",
  kiro: "Kiro CLI", goose: "Goose", pi: "Pi", cursor: "Cursor CLI", grok: "Grok Build", gemini: "Gemini CLI",
  "copilot-cli": "Copilot CLI", "copilot-vscode": "Copilot in VS Code", crush: "Crush", vibe: "Mistral Vibe",
};

export const agentName = (a) => NAMES[a] ?? a ?? "agent";

// Flags that start an agent without asking before it runs commands.
export const RISKY = /--dangerously|--yolo|bypass/;

export function ago(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30))}mo`;
  return `${Math.floor(s / (86400 * 365))}y`;
}

// ~ for the home folder; a long path keeps its last three folders.
export function tidy(dir) {
  const h = home();
  const p = h && (dir === h || dir.startsWith(h + "/")) ? "~" + dir.slice(h.length) : dir;
  const parts = p.split("/");
  return parts.length > 4 ? "…/" + parts.slice(-3).join("/") : p;
}

// The command as you'd type it in a shell (what Ctrl+Y copies).
export function shellJoin(argv) {
  return argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(a) ? a : `'${String(a).replace(/'/g, `'\\''`)}'`)).join(" ");
}

// ---- finding and running hb ------------------------------------------------------------

export const MIN_VERSION = [0, 2, 0]; // the first hb with --json, pin, rename, hide and fork --json
export const NOT_INSTALLED = "hopback isn't installed. Install it with: brew install avgvi/tap/hopback (or cargo install hopback)";

// Herdr starts programs with its own PATH, which may not include ~/.cargo/bin, so look in
// the places each install method uses.
let HB = null;
export async function findHb() {
  if (HB) return HB;
  const h = home();
  const places = [
    "hb",
    `${h}/.cargo/bin/hb`,
    "/opt/homebrew/bin/hb",
    "/usr/local/bin/hb",
    "/home/linuxbrew/.linuxbrew/bin/hb",
    `${h}/.local/bin/hb`,
    `${h}/.local/share/mise/shims/hb`,
    `${h}/.nix-profile/bin/hb`,
    "/run/current-system/sw/bin/hb",
  ];
  for (const bin of places) {
    try {
      const r = await exec(bin, ["--version"], { timeout: 5000 });
      if (r.code !== 0) continue;
      const v = (r.stdout.match(/(\d+)\.(\d+)\.(\d+)/) ?? []).slice(1).map(Number);
      // Not kept when too old, so an upgrade counts without restarting Herdr.
      if (v.length === 3 && older(v, MIN_VERSION))
        return { bin, error: `hopback ${v.join(".")} is too old for this mod; it needs ${MIN_VERSION.join(".")} or later` };
      return (HB = { bin, error: null });
    } catch {}
  }
  return null;
}

function older(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}

// Runs hb. Resolves to { ok, data (parsed JSON when asked for), out, error }.
export async function hb(args, opts = {}) {
  const found = await findHb();
  if (!found) return { ok: false, error: NOT_INSTALLED };
  if (found.error) return { ok: false, error: found.error };
  let r;
  try {
    r = await exec(found.bin, args, { timeout: 60000, ...opts });
  } catch (e) {
    HB = null; // moved or uninstalled: look again next time
    return { ok: false, error: String(e?.message ?? e) };
  }
  if (r.code !== 0) {
    const last = (r.stderr || "").trim().split("\n").pop() || `hb stopped with code ${r.code}`;
    return { ok: false, error: last.replace(/^Error:\s*/, "").replace(/^./, (c) => c.toUpperCase()) };
  }
  if (!args.includes("--json")) return { ok: true, out: r.stdout };
  try {
    return { ok: true, data: JSON.parse(r.stdout) };
  } catch {
    return { ok: false, error: "hopback's answer couldn't be read" };
  }
}

export const selector = (s) => `${s.agent}:${s.id}`;

// ---- opening a session in Herdr ----------------------------------------------------------

// The space on this computer whose folder holds dir most closely.
export function spaceFor(dir) {
  let best = null;
  for (const sp of spaces()) {
    if (sp.machine || !sp.folder) continue;
    const f = sp.folder.replace(/\/$/, "");
    if (dir === f || dir.startsWith(f + "/")) {
      if (!best || f.length > best.folder.length) best = sp;
    }
  }
  return best;
}

// hb's command, as Herdr starts agents: Codex without its shared daemon, so this session
// doesn't take another terminal's identity or stop with it.
export function argvOf(cmd) {
  const argv = Array.isArray(cmd) ? cmd.map(String) : [];
  if (argv[0] === "codex" && !argv.includes("--no-daemon")) argv.splice(1, 0, "--no-daemon");
  return argv;
}

// Does this terminal's command run session `id`? A native fork's command names the session
// it starts from after --resume; that one isn't open there, the fork is.
function runs(argv, id) {
  const i = argv.indexOf(id);
  if (i < 0) return false;
  return !(argv.includes("--fork-session") && argv[i - 1] === "--resume");
}

// The Herdr terminal where an agent is running session `id` right now, or null. It looks at
// the program in front (`foreground`), so a session started by hand counts too; the command
// a tab was opened with counts only while something other than the shell is in front (after
// the agent quits, the shell stays).
export function openTerminal(id) {
  if (!id) return null;
  let list = [];
  try {
    list = terminals() ?? [];
  } catch {}
  for (const t of list) {
    if (!t || (t.state && t.state !== "live")) continue;
    const front = Array.isArray(t.foreground?.argv) ? t.foreground.argv.map(String) : [];
    if (runs(front, id)) return t;
    const argv = Array.isArray(t.argv) ? t.argv.map(String) : [];
    if (runs(argv, id) && t.program && t.program.shell === false) return t;
  }
  return null;
}

// Brings an open terminal to the front: its space, its tab, then the pane itself.
export function jumpTo(t) {
  const addr = String(t.address ?? t.id ?? "");
  const pane = panes().find((p) => p.terminal && (p.terminal === addr || addr.endsWith("/" + p.terminal)));
  if (pane) {
    const sp = spaces().find((s) => s.tabs.some((tb) => tb.id === pane.tab));
    if (sp) run("space.select", { id: sp.id });
    run("tab.select", { id: pane.tab });
    run("pane.focus", { pane: pane.pane });
  } else {
    run("pane.focus", { terminal: addr });
  }
}

// Opens argv in dir: a new tab in the space that holds dir, else a new space.
// Resolves to false when it couldn't (the folder is gone).
export async function openIn(dir, argv, name) {
  dir = dir || home();
  const there = await exec("test", ["-d", dir]).then((r) => r.code === 0, () => false);
  if (!there) {
    notify({ title: "That folder is gone", body: `${tidy(dir)} no longer exists, so the session can't start there.`, level: "warning" });
    return false;
  }
  const sp = spaceFor(dir);
  if (sp) {
    run("space.select", { id: sp.id });
    run("tab.new", { space: sp.id, folder: dir, argv, name });
  } else {
    run("space.new", { folder: dir, argv, tab: name });
  }
  return true;
}

// Resume a session from hb's JSON: go to it when it's already open, else open it.
export async function resumeSession(s) {
  const open = openTerminal(s.id);
  if (open) {
    jumpTo(open);
    return true;
  }
  const argv = argvOf(s.resume_command);
  if (!argv.length) return false;
  return openIn(s.directory, argv, (s.title || agentName(s.agent)).slice(0, 40));
}
