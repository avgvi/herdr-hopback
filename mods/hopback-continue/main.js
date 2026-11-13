// Continue: reopen the newest coding-agent session of the folder you're in, without the
// hopback pop-up. Opened with cmd-shift-. (keys.json: "mod.open:hopback-continue").
// It asks hopback (`hb . --print`) which session that is, looking in the focused terminal's
// folder and then the folders above it. When the session is open already, it goes to its tab.

import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import { focused, spaces, home, theme, props, closeOverlay, notify } from "herdr";
import { hb, tidy, resumeSession, NOT_INSTALLED } from "./lib.js";

export default class Continue extends View {
  init(_props, cx) {
    cx.spawn(async () => {
      let msg = null;
      try {
        msg = await this.go();
      } catch (e) {
        msg = { title: "hopback", body: String(e?.message ?? e), level: "error" };
      }
      if (msg) notify(msg);
      closeOverlay(props().overlay);
    });
  }

  where() {
    const f = focused();
    if (f?.cwd) return f.cwd;
    const sp = spaces().find((s) => s.active);
    return (sp && !sp.machine && sp.folder) || home();
  }

  async go() {
    const dir = this.where();
    const p = await hb([".", "--print"], { cwd: dir });
    if (!p.ok) {
      if (/no session found/i.test(p.error))
        return { title: "Nothing to continue here", body: `hopback found no session in ${tidy(dir)} or the folders above it.`, level: "info" };
      return { title: p.error === NOT_INSTALLED ? "hopback isn't installed" : "hopback", body: p.error, level: "error" };
    }
    const [folder, command = ""] = p.out.trim().split("\n");
    const r = await hb(["--json", "--all", "--no-refresh", "-d", folder]);
    if (!r.ok) return { title: "hopback", body: r.error, level: "error" };
    const here = (r.data.sessions ?? []).filter((s) => s.directory === folder);
    const s = here.find((x) => command.includes(x.id)) ?? here.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0];
    if (!s) return { title: "Nothing to continue here", body: `hopback found no session in ${tidy(dir)} or the folders above it.`, level: "info" };
    await resumeSession(s);
    if (folder !== dir) return { title: "Continued from a folder above", body: `No session in ${tidy(dir)}, so this is the newest one in ${tidy(folder)}.`, level: "info" };
    return null;
  }

  render() {
    const t = theme();
    return h_flex()
      .w_full()
      .h_full()
      .px(14)
      .items_center()
      .rounded(9)
      .border_1()
      .border_color(t.border)
      .bg(t.popover)
      .text_size(12.5)
      .text_color(t.dim)
      .child(div().truncate().child("Finding the newest session here…"));
  }
}
