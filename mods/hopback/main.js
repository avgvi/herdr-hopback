// hopback: find a past coding-agent session with hopback (`hb`, github.com/avgvi/hopback) and
// reopen it in Herdr, or pin, rename, hide, copy or fork it. Opened with cmd-shift-r
// (keys.json: "mod.open:hopback"). Its keys work only while this pop-up is open; closed,
// they go back to the terminal as before.
//
// Type to search; hb's syntax works (agent:codex, dir:vault, date:<2d).
//   ↑↓ pick   Enter resume (or go to its tab when it's open already)   Esc close
//   Ctrl+O actions menu, which lists the rest:
//   Tab / Shift+Tab agent   Ctrl+S everywhere / this space   Ctrl+T pin   Ctrl+R or F2 rename
//   Ctrl+F fork   Ctrl+Y copy the resume command   Ctrl+X hide
// The menu also sets hopback's permission policy (whether agents start with their
// skip-permissions flag), as `hb config permission set` does; clicking the red footer note
// opens the same choice.
// The Ctrl keys are the hb TUI's own, so one set works in both. Herdr closes every pop-up on
// Esc before the mod sees it, so the menu, the fork choice and a rename end with their own
// key pressed again (Ctrl+O, Ctrl+F, Ctrl+R), or by typing in the search box.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { spaces, knownAgents, theme, props, closeOverlay, notify } from "herdr";
import { agentName, RISKY, ago, tidy, shellJoin, hb, selector, argvOf, openIn, openTerminal, resumeSession } from "./lib.js";

const ROW = 46; // px per result row
const ROWS = 9; // rows shown at once (the popup sizes itself to its content)
const LIMIT = "60"; // results asked of hb per search
const DEBOUNCE = 140; // ms after the last keystroke before searching
const ICONS = "mods/workspace-chrome";
const OTHER = { claude: "codex", codex: "claude" }; // translated forks hb can make

// hopback's permission policies (`hb config permission set <value>`; `get` prints `id`, or
// "ask" when none is stored, which outside hb's own TUI acts like inherit).
const POLICIES = [
  { value: "normal", id: "always_normal", label: "Ask first", about: "Agents start in their normal mode and ask before running commands or editing files" },
  { value: "yolo", id: "always_yolo", label: "Skip permission prompts", about: "Agents start with their skip-permissions flag and act without asking" },
  { value: "inherit", id: "inherit_known", label: "Keep each session's own mode", about: "As the session was first started, when its agent recorded that; otherwise ask first" },
];
const policyLabel = (id) => POLICIES.find((p) => p.id === id)?.label ?? (id === "ask" ? "Not set (each session's own mode)" : id || "…");

export default class Hopback extends View {
  init(_props, cx) {
    this.query = "";
    this.here = false; // Ctrl+S: only sessions under the shown space's folder
    this.agent = null; // Tab: one agent's sessions, null for all
    this.agents = []; // [{ id, n }] for the agent tabs, most sessions first
    this.showHidden = false;
    this.sessions = [];
    this.total = 0;
    this.at = 0;
    this.top = 0;
    this.wheel = 0;
    this.seq = 0;
    this.loading = true;
    this.error = null;
    this.refreshed = false;
    this.busy = false;
    this.mode = "list"; // list | menu | fork | rename | perm
    this.menuAt = 0;
    this.policy = null; // hb's permission policy id, or "ask" when none is stored
    this.permAt = 0;
    this.fork = null; // { session, choices: [{ to, label, about }], at, loading, error }
    this.flash = null; // { text, bad } shown in the footer for a few seconds
    this.flashSeq = 0;
    this.icons = {};

    this.input = InputState.new({ placeholder: "Search past sessions…   agent:codex   dir:vault   date:<2d" });
    this.input.on("change", (_e, cx) => {
      const q = this.input.value();
      if (q === this.query) return;
      this.query = q;
      if (this.mode === "menu" || this.mode === "fork" || this.mode === "perm") this.mode = "list";
      this.schedule(cx);
    });
    this.input.on("submit", (_e, cx) => this.enter(cx));
    this.renameInput = InputState.new({ placeholder: "New title (leave empty for the agent's own)" });
    this.renameInput.on("submit", (_e, cx) => this.saveRename(cx));

    this.input.focus();
    cx.timer.after(400, () => {
      if (this.mode !== "rename") this.input.focus();
    });
    cx.spawn(async (cx) => {
      try {
        for (const a of await knownAgents()) if (a.icon) this.icons[a.key] = a;
      } catch {}
      cx.notify();
    });
    cx.spawn(async (cx) => {
      const r = await hb(["config", "permission", "get"]);
      if (r.ok) this.policy = r.out.trim();
      cx.notify();
    });
    this.search(cx);
  }

  close() {
    closeOverlay(props().overlay);
  }

  current() {
    return this.sessions[this.at] ?? null;
  }

  shownSpace() {
    const sp = spaces().find((s) => s.active);
    return sp && !sp.machine && sp.folder ? sp : null;
  }

  say(text, cx, bad = false) {
    this.flash = { text, bad };
    const mine = ++this.flashSeq;
    cx.timer.after(3500, (cx) => {
      if (mine !== this.flashSeq) return;
      this.flash = null;
      cx.notify();
    });
    cx.notify();
  }

  // ---- searching ----------------------------------------------------------------------

  schedule(cx) {
    const mine = ++this.seq;
    cx.timer.after(DEBOUNCE, (cx) => {
      if (mine === this.seq) this.search(cx);
    });
  }

  // keep: a session to stay on after the list reloads (after pin, rename, hide).
  search(cx, keep = null) {
    const mine = ++this.seq;
    // The first search refreshes hb's index; the ones while typing read it as it is.
    const args = ["--json", "--limit", LIMIT];
    if (this.refreshed) args.push("--no-refresh");
    if (this.showHidden) args.push("--include-hidden");
    if (this.agent) args.push("-a", this.agent);
    const sp = this.here ? this.shownSpace() : null;
    if (sp) args.push("-d", sp.folder);
    // After "--", a search for "fork" or "pin" is text, not one of hb's commands.
    if (this.query.trim()) args.push("--", this.query.trim());
    this.loading = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hb(args);
      if (mine !== this.seq) return; // a newer search started meanwhile
      const first = !this.refreshed;
      this.refreshed = true;
      this.loading = false;
      if (!r.ok) {
        this.sessions = [];
        this.error = r.error;
      } else {
        this.sessions = r.data.sessions ?? [];
        this.total = r.data.meta?.total ?? this.sessions.length;
        this.error = null;
      }
      const k = keep ? this.sessions.findIndex((s) => s.agent === keep.agent && s.id === keep.id) : -1;
      this.at = k >= 0 ? k : keep ? Math.min(this.at, Math.max(0, this.sessions.length - 1)) : 0;
      if (!keep) {
        this.top = 0;
        this.wheel = 0;
      }
      if (first && r.ok) this.countAgents(cx);
      cx.notify();
    });
  }

  // The agent tabs: every agent hb has sessions for, most first.
  countAgents(cx) {
    cx.spawn(async (cx) => {
      const r = await hb(["--json", "--all", "--no-refresh"]);
      if (!r.ok) return;
      const n = {};
      for (const s of r.data.sessions ?? []) n[s.agent] = (n[s.agent] ?? 0) + 1;
      this.agents = Object.entries(n)
        .sort((a, b) => b[1] - a[1])
        .map(([id, c]) => ({ id, n: c }));
      cx.notify();
    });
  }

  setAgent(id, cx) {
    if (id === this.agent) return;
    this.agent = id;
    this.mode = "list";
    this.search(cx);
  }

  cycleAgent(by, cx) {
    const ids = [null, ...this.agents.map((a) => a.id)];
    const i = Math.max(0, ids.indexOf(this.agent));
    this.setAgent(ids[(i + by + ids.length) % ids.length], cx);
  }

  setScope(here, cx) {
    if (here === this.here) return;
    this.here = here;
    this.mode = "list";
    this.search(cx);
  }

  // ---- actions --------------------------------------------------------------------------

  enter(cx) {
    if (this.mode === "menu") return this.runMenu(this.menuItems()[this.menuAt]?.id, cx);
    if (this.mode === "fork") return this.doFork(cx);
    if (this.mode === "perm") return this.setPolicy(this.permAt, cx);
    if (this.mode === "list") this.resume(this.current(), cx);
  }

  openPerm(cx) {
    this.mode = "perm";
    this.permAt = Math.max(0, POLICIES.findIndex((p) => p.id === this.policy));
    this.input.focus(); // a click on the footer note takes the keyboard from the search box
    cx.notify();
  }

  // Stores the policy in hopback, then reloads the list: resume commands change with it.
  setPolicy(i, cx) {
    const p = POLICIES[i];
    if (!p || this.busy) return;
    this.mode = "list";
    if (p.id === this.policy) return cx.notify();
    this.busy = true;
    cx.spawn(async (cx) => {
      const r = await hb(["config", "permission", "set", p.value]);
      this.busy = false;
      if (r.ok) {
        this.policy = p.id;
        this.say(`Set to “${p.label}”`, cx);
      } else this.say(r.error, cx, true);
      this.search(cx, this.current());
    });
  }

  resume(s, cx) {
    if (!s || this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      const ok = await resumeSession(s);
      this.busy = false;
      if (ok) this.close();
      else cx.notify();
    });
  }

  // Runs an hb change on the selected session, says how it went, reloads the list.
  change(args, done, cx) {
    const s = this.current();
    if (!s || this.busy) return;
    this.mode = "list";
    this.busy = true;
    cx.spawn(async (cx) => {
      const r = await hb(args(s));
      this.busy = false;
      if (r.ok) this.say(done(s), cx);
      else this.say(r.error, cx, true);
      this.search(cx, s);
    });
  }

  togglePin(cx) {
    this.change(
      (s) => [s.pinned ? "unpin" : "pin", "--json", "--no-refresh", "--", selector(s)],
      (s) => (s.pinned ? "Unpinned" : "Pinned to the top"),
      cx,
    );
  }

  toggleHide(cx) {
    this.change(
      (s) => [s.hidden ? "unhide" : "hide", "--json", "--no-refresh", "--", selector(s)],
      (s) => (s.hidden ? "Shown again" : "Hidden (Ctrl+O shows hidden ones)"),
      cx,
    );
  }

  copy(cx) {
    const s = this.current();
    if (!s) return;
    this.mode = "list";
    cx.write_to_clipboard(shellJoin((s.resume_command ?? []).map(String)));
    this.say("Copied the resume command", cx);
  }

  startRename(cx) {
    const s = this.current();
    if (!s) return;
    this.mode = "rename";
    this.renameInput.set_value(s.title || "");
    this.renameInput.focus();
    cx.notify();
  }

  endRename(cx) {
    this.mode = "list";
    this.input.focus();
    cx.notify();
  }

  saveRename(cx) {
    const s = this.current();
    const title = this.renameInput.value().trim();
    this.endRename(cx);
    if (!s || title === (s.title || "")) return;
    this.change(
      () => (title ? ["rename", "--json", "--no-refresh", "--", selector(s), title] : ["rename", "--json", "--no-refresh", "--reset", "--", selector(s)]),
      () => (title ? "Renamed" : "Back to the agent's own title"),
      cx,
    );
  }

  // Ctrl+F: ask hb (dry runs, nothing written) which forks this session allows.
  startFork(cx) {
    const s = this.current();
    if (!s) return;
    const tries = [{ to: null, label: `Fork in ${agentName(s.agent)}`, about: `A new ${agentName(s.agent)} session that starts from this one's history` }];
    const other = OTHER[s.agent];
    if (other) tries.push({ to: other, label: `Fork to ${agentName(other)}`, about: `Copies the conversation into a new ${agentName(other)} session` });
    this.mode = "fork";
    this.fork = { session: s, choices: [], at: 0, loading: true, error: null };
    cx.notify();
    cx.spawn(async (cx) => {
      const results = await Promise.all(
        tries.map((c) => hb(["fork", "--json", "--dry-run", "--no-refresh", ...(c.to ? ["--to", c.to] : []), "--", selector(s)])),
      );
      if (this.fork?.session !== s) return;
      this.fork.loading = false;
      this.fork.choices = tries.filter((_, i) => results[i].ok);
      if (!this.fork.choices.length) this.fork.error = results[0].error;
      cx.notify();
    });
  }

  doFork(cx) {
    const f = this.fork;
    const c = f?.choices[f.at];
    if (!c || this.busy) return;
    const s = f.session;
    this.busy = true;
    cx.notify();
    cx.spawn(async (cx) => {
      const r = await hb(["fork", "--json", "--no-refresh", ...(c.to ? ["--to", c.to] : []), "--", selector(s)]);
      this.busy = false;
      if (!r.ok) {
        f.error = r.error;
        return cx.notify();
      }
      for (const w of r.data.warnings ?? []) notify({ title: "hopback", body: String(w), level: "warning" });
      const argv = argvOf(r.data.launch_command);
      const name = `${(s.title || agentName(s.agent)).slice(0, 30)} (fork${c.to ? " → " + agentName(c.to) : ""})`;
      if (argv.length && (await openIn(r.data.session?.directory || s.directory, argv, name))) this.close();
      else cx.notify();
    });
  }

  menuItems() {
    const s = this.current();
    const items = [];
    if (s) {
      items.push(
        { id: "resume", key: "Enter", label: openTerminal(s.id) ? "Go to its tab" : "Resume" },
        { id: "fork", key: "Ctrl+F", label: "Fork…" },
        { id: "pin", key: "Ctrl+T", label: s.pinned ? "Unpin" : "Pin to the top" },
        { id: "rename", key: "Ctrl+R", label: "Rename" },
        { id: "copy", key: "Ctrl+Y", label: "Copy the resume command" },
        { id: "hide", key: "Ctrl+X", label: s.hidden ? "Unhide" : "Hide from hopback" },
      );
    }
    items.push(
      { id: "scope", key: "Ctrl+S", label: this.here ? "Search everywhere" : "Search only this space" },
      { id: "agent", key: "Tab", label: "Next agent" },
      { id: "hidden", key: "", label: this.showHidden ? "Stop showing hidden sessions" : "Show hidden sessions" },
      { id: "perm", key: "", label: `Permission prompts: ${policyLabel(this.policy)}…` },
    );
    return items;
  }

  openMenu(cx) {
    this.mode = "menu";
    this.menuAt = 0;
    this.input.focus(); // the ⋯ button takes the keyboard from the search box
    cx.notify();
  }

  runMenu(id, cx) {
    this.mode = "list";
    switch (id) {
      case "resume": return this.resume(this.current(), cx);
      case "fork": return this.startFork(cx);
      case "pin": return this.togglePin(cx);
      case "rename": return this.startRename(cx);
      case "copy": return this.copy(cx);
      case "hide": return this.toggleHide(cx);
      case "scope": return this.setScope(!this.here, cx);
      case "agent": return this.cycleAgent(1, cx);
      case "hidden":
        this.showHidden = !this.showHidden;
        return this.search(cx, this.current());
      case "perm": return this.openPerm(cx);
    }
    cx.notify();
  }

  // A panel's own key, pressed again, goes back to the list.
  toList(cx) {
    if (this.mode === "rename") return this.endRename(cx);
    this.mode = "list";
    cx.notify();
  }

  move(by) {
    if (this.mode === "menu") {
      const n = this.menuItems().length;
      this.menuAt = Math.max(0, Math.min(n - 1, this.menuAt + by));
    } else if (this.mode === "fork") {
      const n = this.fork?.choices.length ?? 0;
      if (n) this.fork.at = Math.max(0, Math.min(n - 1, this.fork.at + by));
    } else if (this.mode === "perm") {
      this.permAt = Math.max(0, Math.min(POLICIES.length - 1, this.permAt + by));
    } else {
      const n = this.sessions.length;
      if (n) this.at = Math.max(0, Math.min(n - 1, this.at + by));
    }
  }

  onKey(e, cx) {
    const k = e.key;
    const m = e.modifiers ?? {};
    if (k === "escape") return this.close();
    const ctrl = m.control && !m.platform && !m.alt;
    if (this.mode === "rename") {
      // The title box has the other keys; Enter saves.
      if ((ctrl && k === "r") || k === "f2") {
        cx.stop_propagation();
        this.toList(cx);
      }
      return;
    }
    const keys = {
      o: () => (this.mode === "menu" ? this.toList(cx) : this.openMenu(cx)),
      t: () => this.togglePin(cx),
      r: () => this.startRename(cx),
      f: () => (this.mode === "fork" ? this.toList(cx) : this.startFork(cx)),
      y: () => this.copy(cx),
      x: () => this.toggleHide(cx),
      s: () => this.setScope(!this.here, cx),
    };
    if (ctrl && keys[k]) keys[k]();
    else if (k === "f2" && !ctrl) this.startRename(cx);
    else if (k === "down") this.move(1);
    else if (k === "up") this.move(-1);
    else if (k === "pagedown") this.move(ROWS);
    else if (k === "pageup") this.move(-ROWS);
    else if (k === "tab") this.cycleAgent(m.shift ? -1 : 1, cx);
    else if (this.mode === "fork" && /^[1-9]$/.test(k) && !ctrl) {
      if (this.fork && Number(k) <= this.fork.choices.length) {
        this.fork.at = Number(k) - 1;
        this.doFork(cx);
      }
    } else if (this.mode === "perm" && /^[1-9]$/.test(k) && !ctrl) {
      if (Number(k) <= POLICIES.length) this.setPolicy(Number(k) - 1, cx);
    } else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ---- drawing ------------------------------------------------------------------------

  icon(t, agent) {
    const a = this.icons[agent];
    if (!a) return div().size(16).rounded(4).bg(t.border);
    return a.tint ? svg(a.icon).size(16).text_color(t.foreground) : image(a.icon).size(16);
  }

  badge(t, text, color) {
    return div().flex_none().px(5).rounded(4).border_1().border_color(color).text_size(10).text_color(color).child(text);
  }

  row(t, s, i) {
    const on = i === this.at;
    const renaming = on && this.mode === "rename";
    const open = !!openTerminal(s.id);
    const about = [agentName(s.agent), tidy(s.directory || "")];
    if (s.forked_from) about.push(`fork of a ${agentName(s.forked_from.agent)} session`);
    const title = renaming
      ? h_flex().h(20).px(6).rounded(5).border_1().border_color(t.accent).bg(t.background)
          .child(Input.new(this.renameInput).flex_1().h_full().text_size(12.8).text_color(t.foreground))
      : h_flex().gap(5).items_center().min_w(0)
          .when(!!s.pinned, (el) => el.child(svg(`${ICONS}/pin.svg`).size(12).flex_none().text_color(t.accent)))
          .child(div().truncate().text_size(13).text_color(s.hidden ? t.dim : t.foreground).child(s.title || "(untitled)"));
    return h_flex()
      .id(`hb-${i}`)
      .h(ROW)
      .flex_none()
      .mx(4)
      .px(10)
      .gap(10)
      .items_center()
      .rounded(7)
      .cursor_pointer()
      .when(on, (el) => el.bg(t.hover))
      .hover((st) => st.bg(t.hover))
      .on_click((_e, cx) => {
        if (this.mode === "rename") return;
        this.at = i;
        this.mode = "list";
        this.resume(s, cx);
      })
      .child(div().flex_none().child(this.icon(t, s.agent)))
      .child(v_flex().flex_1().min_w(0).gap(2).child(title).child(div().truncate().text_size(11).text_color(t.dim).child(about.join(" · "))))
      .when(!!s.hidden, (el) => el.child(this.badge(t, "hidden", t.dim)))
      .when(open, (el) => el.child(this.badge(t, "open", t.accent)))
      .when(on && this.mode === "list", (el) =>
        el.child(
          div().id(`hb-more-${i}`).flex_none().px(6).rounded(4).text_size(13).text_color(t.dim)
            .hover((st) => st.bg(t.border).text_color(t.foreground))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.at = i;
              this.openMenu(cx);
            })
            .child("⋯"),
        ),
      )
      .child(div().flex_none().w(32).text_size(11).text_color(t.dim).child(ago(s.timestamp)));
  }

  // A small list in place of the results: the actions menu or the fork choices.
  panel(t, heading, items, at, pick) {
    return v_flex()
      .p(4)
      .gap(2)
      .child(div().px(10).pt(4).pb(8).truncate().text_size(12).text_color(t.dim).child(heading))
      .children(
        items.map((it, i) =>
          h_flex()
            .id(`hb-p-${i}`)
            .h(it.about ? 46 : 32)
            .flex_none()
            .px(10)
            .gap(10)
            .items_center()
            .rounded(7)
            .cursor_pointer()
            .when(i === at, (el) => el.bg(t.hover))
            .hover((st) => st.bg(t.hover))
            .on_click((_e, cx) => pick(i, cx))
            .child(
              v_flex().flex_1().min_w(0).gap(2)
                .child(div().text_size(13).text_color(t.foreground).child(it.label))
                .when(!!it.about, (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(it.about))),
            )
            .when(!!it.key, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(it.key))),
        ),
      );
  }

  chip(t, id, label, on, click) {
    return div()
      .id(id)
      .px(8)
      .py(3)
      .rounded(6)
      .text_size(11.5)
      .cursor_pointer()
      .text_color(on ? t.foreground : t.dim)
      .when(on, (el) => el.bg(t.hover))
      .hover((st) => st.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => click(cx))
      .child(label);
  }

  body(t) {
    const s = this.current();
    if (this.mode === "menu") {
      return this.panel(t, s ? s.title || "(untitled)" : "hopback", this.menuItems(), this.menuAt, (i, cx) => this.runMenu(this.menuItems()[i]?.id, cx));
    }
    if (this.mode === "fork" && this.fork) {
      const f = this.fork;
      const heading = `Fork “${f.session.title || "(untitled)"}”`;
      if (f.loading) return this.panel(t, heading, [{ label: "Checking which forks this session allows…" }], -1, () => {});
      if (this.busy) return this.panel(t, heading, [{ label: "Forking…" }], -1, () => {});
      const items = f.choices.map((c, i) => ({ ...c, key: String(i + 1) }));
      const el = this.panel(t, heading, items, f.at, (i, cx) => {
        f.at = i;
        this.doFork(cx);
      });
      return f.error ? el.child(div().px(10).pt(6).text_size(12).text_color(t.blocked).child(f.error)) : el;
    }
    if (this.mode === "perm") {
      const items = POLICIES.map((p, i) => ({ ...p, key: p.id === this.policy ? `current · ${i + 1}` : String(i + 1) }));
      return this.panel(t, "When hopback starts an agent (also for hb in the terminal)", items, this.permAt, (i, cx) => this.setPolicy(i, cx));
    }
    if (this.error) return div().p(14).text_size(12.5).text_color(t.blocked).child(this.error);
    const count = this.sessions.length;
    if (!count) return div().p(14).text_size(12.5).text_color(t.dim).child(this.loading ? "Searching…" : "No sessions match.");
    return v_flex().children(this.sessions.slice(this.top, this.top + ROWS).map((s, k) => this.row(t, s, this.top + k)));
  }

  hints() {
    if (this.mode === "rename") return ["Enter save", "Ctrl+R cancel", "Esc close"];
    if (this.mode === "fork") return this.fork?.choices.length ? ["↑↓ pick", "Enter fork", "Ctrl+F back", "Esc close"] : ["Ctrl+F back", "Esc close"];
    if (this.mode === "menu") return ["↑↓ pick", "Enter run", "Ctrl+O back", "Esc close"];
    if (this.mode === "perm") return ["↑↓ pick", "Enter set", "Ctrl+O menu", "Esc close"];
    const s = this.current();
    return ["↑↓ pick", s && openTerminal(s.id) ? "Enter go to tab" : "Enter resume", "Ctrl+O actions", "Esc close"];
  }

  render(cx) {
    const t = theme();
    const count = this.sessions.length;
    if (this.at < this.top) this.top = this.at;
    if (this.at >= this.top + ROWS) this.top = this.at - ROWS + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, count - ROWS)));
    const sp = this.shownSpace();
    const s = this.current();

    let status = null;
    if (this.flash) status = div().text_color(this.flash.bad ? t.blocked : t.foreground).child(this.flash.text);
    else if (this.mode === "list" && s && (s.resume_command ?? []).some((x) => RISKY.test(String(x))))
      status = div()
        .id("hb-perm-note")
        .cursor_pointer()
        .text_color(t.blocked)
        .hover((st) => st.text_color(t.foreground))
        .on_click((_e, cx) => this.openPerm(cx))
        .child("starts without permission prompts");
    const where = this.error || this.loading ? (this.loading ? "searching…" : "") : count ? `${this.at + 1} of ${count}${this.total > count ? ` (${this.total} match)` : ""}` : "";

    const tabs = [{ id: null, label: "All" }, ...this.agents.map((a) => ({ id: a.id, label: `${agentName(a.id)} ${a.n}` }))];

    return v_flex()
      .id("hopback")
      .w_full()
      .min_h(0)
      .p(18)
      .gap(10)
      .bg(t.popover)
      .text_size(13)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(
        h_flex().items_center().gap(8)
          .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Resume a session"))
          .when(this.showHidden, (el) => el.child(this.chip(t, "hb-hidden", "Showing hidden ✕", true, (cx) => this.runMenu("hidden", cx))))
          .child(this.chip(t, "hb-all", "Everywhere", !this.here, (cx) => this.setScope(false, cx)))
          .child(this.chip(t, "hb-here", sp ? `This space · ${sp.name}` : "This space", this.here, (cx) => this.setScope(true, cx)))
          .child(div().id("hb-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer().hover((st) => st.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")),
      )
      .child(
        h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(this.mode === "rename" ? t.border : t.accent).bg(t.background)
          .child(svg(`${ICONS}/search.svg`).size(15).text_color(t.dim))
          .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)),
      )
      .when(this.agents.length > 1, (el) =>
        el.child(h_flex().gap(2).items_center().children(tabs.map((a) => this.chip(t, `hb-a-${a.id ?? "all"}`, a.label, a.id === this.agent, (cx) => this.setAgent(a.id, cx))))),
      )
      .child(
        v_flex()
          .id("hb-list")
          .h(ROW * ROWS)
          .flex_none()
          .overflow_hidden()
          .on_scroll_wheel((e, cx) => {
            if (this.mode !== "list") return;
            this.wheel += e.delta.y;
            while (this.wheel <= -ROW) { this.wheel += ROW; this.top = Math.min(this.top + 1, Math.max(0, count - ROWS)); }
            while (this.wheel >= ROW) { this.wheel -= ROW; this.top = Math.max(0, this.top - 1); }
            // The selection stays in view, so the next frame doesn't scroll back to it.
            this.at = Math.max(this.top, Math.min(this.at, this.top + ROWS - 1));
            cx.notify();
          })
          .child(this.body(t)),
      )
      .child(
        h_flex().flex_none().items_center().gap(14).text_size(11).text_color(t.dim)
          .children(this.hints().map((h) => div().flex_none().child(h)))
          .child(div().flex_1())
          .when(!!status, (el) => el.child(status))
          .child(div().flex_none().child(where)),
      );
  }
}
