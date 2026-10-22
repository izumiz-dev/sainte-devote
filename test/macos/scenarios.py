"""Test cases for the Sainte Devote macOS E2E suite.

Grouped by tier:

* **Tier 1** core file handling: open, write, save, session restore.
* **Tier 2** external changes and conflict detection.
* **Tier 3** security boundaries (extension / symlink / write-grant rules).
* **Tier 4** multiple windows: workspaces, file ownership, window lifecycle.

Every case is a plain callable that raises :class:`harness.Failure` with a
human-readable reason.  Cases within a group share the running app and build on
each other in order, so the sequence matters; each case still re-establishes the
tab it needs through ``focus_tab`` so one failure does not cascade.

Tier 4 is the only group that cares which window is in front.  The AX window
order is z-order (``window 1`` is frontmost) and a raise reorders it, so never
carry an index across a raise: re-read ``window_snapshot()`` or raise by tab
name with ``raise_window_with_tab()``.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

from harness import (
    ACTION_KEEP,
    ACTION_RELOAD,
    NOTIFY_CONFLICT,
    NOTIFY_DELETED,
    NOTIFY_READ_ONLY,
    App,
    Failure,
    pbcopy,
    wait_until,
)

ALPHA_V1 = "# Alpha\n\nalpha body line\n"
BETA_V1 = "# Beta\n\nbeta body line\n"
GAMMA_V1 = "# Gamma\n\ngamma body line\n"

EDIT_ALPHA = "# Alpha edited\n\nwritten through the save path\n"
EDIT_BETA = "# Beta edited\n\nwritten by autosave\n"
SCRATCH_MD = "# Scratch\n\nsaved from an untitled tab\n"
RESTORE_MARKER = "restore-me-across-a-restart"

EXTERNAL_A = "# Alpha from outside\n\nsilent reload\n"
EXTERNAL_B = "# Alpha outside B\n\noutside B body\n"
EXTERNAL_C = "# Alpha outside C\n\noutside C body\n"
EXTERNAL_D = "# Alpha outside D\n\noutside D body\n"
LOCAL_B = "# Alpha local B\n\nlocal B body\n"
LOCAL_C = "# Alpha local C\n\nlocal C body\n"


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #
class Fixture:
    """The files the scenarios operate on, all inside the throwaway work dir."""

    def __init__(self, work: Path) -> None:
        self.work = work
        self.alpha = work / "alpha.md"
        self.beta = work / "beta.md"
        self.gamma = work / "gamma.md"
        self.empty = work / "empty.md"
        self.large = work / "large.md"
        self.scratch_target = work / "saved-from-scratch.md"
        self.extension_target = work / "blocked.png"
        self.picture = work / "picture.png"
        self.symlink = work / "link-to-alpha.md"

    def reset(self) -> None:
        """Rewrite every fixture to its canonical content."""
        self.alpha.write_text(ALPHA_V1, encoding="utf-8")
        self.beta.write_text(BETA_V1, encoding="utf-8")
        self.gamma.write_text(GAMMA_V1, encoding="utf-8")
        self.empty.write_text("", encoding="utf-8")
        if not self.large.exists():
            self.large.write_text(
                "# Large\n\n" + ("lorem ipsum dolor sit amet consectetur\n" * 40000),
                encoding="utf-8",
            )
        # A file whose extension is not on the open allowlist.
        self.picture.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64)
        if self.symlink.is_symlink() or self.symlink.exists():
            self.symlink.unlink()
        self.symlink.symlink_to(self.alpha)


@dataclass
class Case:
    id: str
    title: str
    fn: Callable[[], None]
    advisory: bool = False


@dataclass
class Group:
    name: str
    fresh_profile: bool
    cases: list[Case] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Tier 1 -- core file handling
# --------------------------------------------------------------------------- #
def _tier1(app: App, fx: Fixture) -> Group:
    group = Group("Tier 1 core: open / write / save / session", fresh_profile=True)

    def t01():
        if not app.alive():
            raise Failure("the app process is not running")
        if app.window_count() != 1:
            raise Failure(f"expected 1 window, got {app.window_count()}")
        if app.tabs() != ["Untitled 1"]:
            raise Failure(f"expected a single 'Untitled 1' tab, got {app.tabs()}")
        if app.active_tab_title() != "Untitled 1":
            raise Failure(f"window title does not track the tab: {app.title()!r}")
        if "New tab" not in app.button_names():
            raise Failure(f"the tab bar '+' button is missing: {app.button_names()}")
        app.shot("t1-01-startup")

    group.cases.append(Case("T1-01", "fresh profile starts with one scratch tab", t01))

    def t02():
        app.open_file(fx.alpha)
        if not wait_until(lambda: "alpha.md" in app.tabs(), timeout=25):
            raise Failure(f"alpha.md never appeared as a tab: {app.tabs()}")
        app.focus_tab("alpha.md")
        app.assert_buffer("alpha.md", ALPHA_V1, "opened content")
        app.shot("t1-02-open-alpha")

    group.cases.append(Case("T1-02", "File > Open File... loads the file into a tab", t02))

    def t03():
        app.open_file(fx.beta)
        if not wait_until(lambda: "beta.md" in app.tabs(), timeout=25):
            raise Failure(f"beta.md never appeared as a tab: {app.tabs()}")
        tabs = app.tabs()
        if len(tabs) != 3:
            raise Failure(f"expected 3 tabs after opening a second file, got {tabs}")
        app.focus_tab("beta.md")
        app.assert_buffer("beta.md", BETA_V1, "second file content")

    group.cases.append(Case("T1-03", "opening a second file adds a tab", t03))

    def t04():
        before = app.tabs()
        app.open_file(fx.alpha)
        time.sleep(3.0)
        after = app.tabs()
        if after != before:
            raise Failure(f"reopening an open file changed the tab list: {before} -> {after}")
        if app.active_tab_title() != "alpha.md":
            raise Failure(
                f"reopening should focus the existing tab, active is "
                f"{app.active_tab_title()!r}"
            )

    group.cases.append(
        Case("T1-04", "reopening an open file focuses it instead of duplicating", t04)
    )

    def t05():
        app.focus_tab("alpha.md")
        app.set_editor_content(EDIT_ALPHA)
        app.keystroke("s")
        if not wait_until(lambda: EDIT_ALPHA in (app.read(fx.alpha) or ""), timeout=20):
            raise Failure(f"alpha.md was not written: {app.read(fx.alpha)!r}")
        texts = app.static_texts()
        if "Saved" not in texts:
            # Cmd+S on an already-persisted tab is a no-op notification when the
            # content came from disk; the file check above is the real assertion.
            print(f"          note: no 'Saved' notification seen, texts={texts[:6]}")
        app.shot("t1-05-saved")

    group.cases.append(Case("T1-05", "Cmd+S persists an edit to the backing file", t05))

    def t06():
        app.focus_tab("beta.md")
        app.set_editor_content(EDIT_BETA)
        # No Cmd+S: the renderer debounces 300ms and the Rust watcher settles
        # after that, so allow a generous window.
        if not wait_until(lambda: EDIT_BETA in (app.read(fx.beta) or ""), timeout=20):
            raise Failure(f"autosave did not write beta.md: {app.read(fx.beta)!r}")

    group.cases.append(Case("T1-06", "autosave persists an edit without Cmd+S", t06))

    def t07():
        app.focus_tab("Untitled 1")
        app.set_editor_content(SCRATCH_MD)
        app.save_as(fx.scratch_target)
        if not wait_until(fx.scratch_target.exists, timeout=25):
            raise Failure("Save As did not create the target file")
        body = app.read(fx.scratch_target) or ""
        if SCRATCH_MD not in body:
            raise Failure(f"Save As wrote the wrong body: {body!r}")
        if not wait_until(
            lambda: app.active_tab_title() == fx.scratch_target.name, timeout=20
        ):
            raise Failure(
                f"the tab did not rebind to the saved file, title is "
                f"{app.active_tab_title()!r}"
            )
        app.shot("t1-07-save-as")

    group.cases.append(Case("T1-07", "Save As writes a new file and rebinds the tab", t07))

    def t12():
        if "alpha.md" not in app.tabs():
            raise Failure(f"alpha.md is not open: {app.tabs()}")
        app.focus_tab("alpha.md")
        app.keystroke("w")
        if not wait_until(lambda: "alpha.md" not in app.tabs(), timeout=20):
            raise Failure(f"Cmd+W did not close the tab: {app.tabs()}")
        if app.active_tab_title() == "alpha.md":
            raise Failure("the window title still points at the closed tab")

    group.cases.append(Case("T1-12", "Cmd+W closes a tab and moves the title along", t12))

    def t08():
        # Only scratch tabs are persisted (renderer.js scratchTabsForStore()
        # filters out anything with a filePath), so a relaunch must bring back
        # the unsaved tabs -- and must NOT silently reopen file tabs, because
        # that would hand out write grants without a user gesture.
        open_files = [t for t in app.tabs() if t.endswith(".md")]
        app.click_button("New tab")
        if not wait_until(
            lambda: app.active_tab_title().startswith("Untitled "), timeout=20
        ):
            raise Failure(f"a new scratch tab did not open: {app.tabs()}")
        probe_tab = app.active_tab_title()
        app.set_editor_content(f"# Restore probe\n\n{RESTORE_MARKER}\n")
        time.sleep(2.0)
        scratch_before = [t for t in app.tabs() if not t.endswith(".md")]
        app.quit()
        app.launch()
        if not wait_until(lambda: sorted(app.tabs()) == sorted(scratch_before), timeout=45):
            raise Failure(
                f"scratch tabs were not restored: {scratch_before} -> {app.tabs()}"
            )
        reopened = [t for t in app.tabs() if t.endswith(".md")]
        if reopened:
            raise Failure(
                f"file tabs were reopened without a user gesture: {reopened} "
                f"(they were open before the restart: {open_files})"
            )
        tables = app.export_zip(app.work / "restore.zip")
        body = App.zip_entry_for(probe_tab, tables) or ""
        if RESTORE_MARKER not in body:
            raise Failure(
                f"the scratch tab content was not restored: entry={body!r} "
                f"zip={list(tables)}"
            )
        app.shot("t1-08-restored")

    group.cases.append(
        Case(
            "T1-08",
            "relaunch restores scratch tabs with content and leaves file tabs closed",
            t08,
        )
    )

    def t09():
        app.click_button("New tab")
        if not wait_until(
            lambda: app.active_tab_title().startswith("Untitled "), timeout=20
        ):
            raise Failure(f"a new scratch tab did not open: {app.tabs()}")
        probe_tab = app.active_tab_title()
        app.set_editor_content("# Reopen probe\n\nREOPEN_MARKER\n")
        time.sleep(2.0)
        expected = sorted(app.tabs())
        if len(expected) < 2:
            raise Failure(f"expected at least two scratch tabs to restore, got {expected}")
        app.menu("File", "Close Window")
        if not wait_until(lambda: app.window_count() == 0, timeout=25):
            raise Failure(f"the window did not close: {app.windows()}")
        if not app.alive():
            raise Failure("the app quit instead of staying windowless like macOS apps do")
        app.reopen_with_launch_services()
        if not wait_until(lambda: app.window_count() >= 1, timeout=45):
            raise Failure("no window came back after reopening")
        app.focus()
        if not wait_until(lambda: sorted(app.tabs()) == expected, timeout=30):
            raise Failure(f"tabs were not restored on reopen: {expected} -> {app.tabs()}")
        tables = app.export_zip(app.work / "reopen.zip")
        body = App.zip_entry_for(probe_tab, tables) or ""
        if "REOPEN_MARKER" not in body:
            raise Failure(f"the reopened tab lost its content: {body!r}")
        app.shot("t1-09-reopened")

    group.cases.append(
        Case("T1-09", "reopening from zero windows restores the workspace", t09)
    )

    def t11():
        app.open_file(fx.empty)
        if not wait_until(lambda: "empty.md" in app.tabs(), timeout=25):
            raise Failure(f"an empty file did not open: {app.tabs()}")
        app.focus_tab("empty.md")
        app.open_file(fx.large)
        if not wait_until(lambda: "large.md" in app.tabs(), timeout=40):
            raise Failure(f"a large file did not open: {app.tabs()}")
        if not app.alive():
            raise Failure("the app died while opening a large file")
        app.focus_tab("large.md")
        app.shot("t1-11-large")

    group.cases.append(
        Case("T1-11", "empty and large files open without breaking the app", t11)
    )

    def t10():
        # Fresh profile so startup files land in a known tab set.
        app.new_profile(app.home.parent / "home-t10")
        app.launch(extra_args=(str(fx.alpha), str(fx.beta)))
        if not wait_until(
            lambda: {"alpha.md", "beta.md"} <= set(app.tabs()), timeout=45
        ):
            raise Failure(f"startup files were not all opened: {app.tabs()}")
        app.focus_tab("alpha.md")
        # Earlier cases edited alpha.md, so compare against what is on disk now
        # rather than the original fixture text.
        app.assert_buffer("alpha.md", app.read(fx.alpha) or "", "startup file content")

    group.cases.append(
        Case("T1-10", "files passed on the command line open as tabs", t10)
    )

    return group


# --------------------------------------------------------------------------- #
# Tier 2 -- external changes and conflicts
# --------------------------------------------------------------------------- #
def _arm_conflict(app: App, fx: Fixture, local: str, external: str) -> None:
    """Raise the reload-or-keep prompt through the deterministic route.

    The renderer only prompts when a local edit is still at risk.  The two ways
    that happens are a pending autosave (a 300ms-vs-200ms debounce race that
    cannot be hit reliably from outside) and edits made while the file was
    missing -- ``hasLocalEditsWhileMissing`` in renderer.js.  Deleting the file,
    editing, then recreating it therefore reproduces the conflict every time.
    """
    fx.alpha.unlink()
    if not app.wait_for_notification(NOTIFY_DELETED, timeout=20):
        raise Failure(f"no '{NOTIFY_DELETED}' notice after deleting the file")
    app.set_editor_content(local)
    fx.alpha.write_text(external, encoding="utf-8")
    if not app.wait_for_notification(NOTIFY_CONFLICT, timeout=20):
        raise Failure(
            f"the conflict prompt never appeared; notifications="
            f"{app.static_texts()[:8]}"
        )


def _tier2(app: App, fx: Fixture) -> Group:
    group = Group("Tier 2 external sync: reload / conflict", fresh_profile=True)

    def t01():
        app.open_file(fx.alpha)
        if not wait_until(lambda: "alpha.md" in app.tabs(), timeout=25):
            raise Failure(f"alpha.md did not open: {app.tabs()}")
        app.focus_tab("alpha.md")
        fx.alpha.write_text(EXTERNAL_A, encoding="utf-8")
        time.sleep(4.0)
        tables = app.export_zip(app.work / "t2-01.zip")
        body = App.zip_entry_for("alpha.md", tables) or ""
        if "silent reload" not in body:
            raise Failure(f"the outside edit was not picked up: {body!r}")
        if app.has_notification(NOTIFY_CONFLICT):
            raise Failure("a conflict prompt was raised for an untouched tab")
        app.shot("t2-01-reloaded")

    group.cases.append(
        Case("T2-01", "an untouched tab silently adopts an outside edit", t01)
    )

    def t02():
        app.focus_tab("alpha.md")
        _arm_conflict(app, fx, LOCAL_B, EXTERNAL_B)
        actions = [b for b in (ACTION_RELOAD, ACTION_KEEP) if b in app.button_names()]
        if len(actions) != 2:
            raise Failure(
                f"the prompt is missing actions; web view buttons="
                f"{app.button_names()[:12]}"
            )
        app.shot("t2-02-conflict")

    group.cases.append(
        Case("T2-02", "a concurrent write raises the reload-or-keep prompt", t02)
    )

    def t03():
        app.click_button(ACTION_RELOAD)
        time.sleep(2.0)
        tables = app.export_zip(app.work / "t2-03.zip")
        body = App.zip_entry_for("alpha.md", tables) or ""
        if "outside B" not in body:
            raise Failure(f"'Reload from disk' did not adopt the outside version: {body!r}")
        if wait_until(lambda: app.has_notification(NOTIFY_CONFLICT), timeout=5):
            raise Failure("the conflict prompt is still showing after reloading")
        app.shot("t2-03-reloaded")

    group.cases.append(
        Case("T2-03", f"'{ACTION_RELOAD}' adopts the outside version", t03)
    )

    def t04():
        app.focus_tab("alpha.md")
        _arm_conflict(app, fx, LOCAL_C, EXTERNAL_C)
        app.click_button(ACTION_KEEP)
        if not wait_until(lambda: "local C" in (app.read(fx.alpha) or ""), timeout=25):
            raise Failure(
                f"'{ACTION_KEEP}' did not rewrite the file with the local buffer: "
                f"{app.read(fx.alpha)!r}"
            )
        app.shot("t2-04-kept")

    group.cases.append(
        Case("T2-04", f"'{ACTION_KEEP}' rewrites the file from the buffer", t04)
    )

    def t05():
        app.focus_tab("alpha.md")
        fx.alpha.unlink()
        if not app.wait_for_notification(NOTIFY_DELETED, timeout=20):
            raise Failure(
                f"no deletion notice; notifications={app.static_texts()[:8]}"
            )
        app.shot("t2-05-deleted")

    group.cases.append(Case("T2-05", "deleting the file outside warns the user", t05))

    def t06():
        fx.alpha.write_text(EXTERNAL_D, encoding="utf-8")
        time.sleep(4.0)
        tables = app.export_zip(app.work / "t2-06.zip")
        body = App.zip_entry_for("alpha.md", tables) or ""
        if "outside D" not in body:
            raise Failure(f"the recreated file was not picked up: {body!r}")
        if app.has_notification(NOTIFY_CONFLICT):
            raise Failure("a conflict prompt was raised although there were no local edits")
        app.shot("t2-06-recreated")

    group.cases.append(
        Case("T2-06", "a recreated file is adopted when there are no local edits", t06)
    )

    def t07():
        # Advisory: the autosave-vs-watcher race (300ms vs 200ms).  Reproducing
        # it from outside is timing dependent, so a miss is reported but does
        # not fail the run.  T2-02 covers the same prompt deterministically.
        app.focus_tab("alpha.md")
        app.focus_editor()
        attempts = 4
        for attempt in range(1, attempts + 1):
            external = f"# Alpha race {attempt}\n\nrace external {attempt}\n"
            local = f"# Alpha race local {attempt}\n\nrace local {attempt}\n"
            app.append_to_editor(local)
            fx.alpha.write_text(external, encoding="utf-8")
            if wait_until(lambda: app.has_notification(NOTIFY_CONFLICT), timeout=6):
                print(f"          race reproduced on attempt {attempt}/{attempts}")
                return
            app.focus_editor()
        raise Failure(
            f"the autosave race did not reproduce in {attempts} attempts "
            "(expected: the 200ms watcher usually loses to the 300ms autosave)"
        )

    group.cases.append(
        Case(
            "T2-07",
            "advisory: autosave-vs-watcher race raises the same prompt",
            t07,
            advisory=True,
        )
    )

    return group


# --------------------------------------------------------------------------- #
# Tier 3 -- security boundaries
# --------------------------------------------------------------------------- #
def _tier3(app: App, fx: Fixture) -> Group:
    group = Group("Tier 3 security boundaries", fresh_profile=True)

    def _send_second_instance(path: Path) -> list[str]:
        """Hand a path to the running app the way Finder's Open With does."""
        before = app.tabs()
        app.launch_second_instance(path)
        time.sleep(4.0)
        return before

    def t01():
        before = _send_second_instance(fx.symlink)
        if "link-to-alpha.md" in app.tabs():
            raise Failure(f"a symlinked file was opened: {app.tabs()}")
        if sorted(app.tabs()) != sorted(before):
            raise Failure(f"the tab list changed: {before} -> {app.tabs()}")
        if not app.alive():
            raise Failure("the app died on the symlinked path")
        app.shot("t3-01-symlink")

    group.cases.append(
        Case("T3-01", "a symlinked path handed to the app is refused", t01)
    )

    def t04():
        before = _send_second_instance(fx.picture)
        if "picture.png" in app.tabs():
            raise Failure(f"a .png file was opened: {app.tabs()}")
        if sorted(app.tabs()) != sorted(before):
            raise Failure(f"the tab list changed: {before} -> {app.tabs()}")

    group.cases.append(
        Case("T3-04", "a path with a non-markdown extension is refused", t04)
    )

    def t02():
        # The native Save panel is built with a "Markdown Files" filter
        # (lib.rs add_filter(["md", "markdown", "txt"])), so the panel itself
        # rewrites the extension before Rust ever sees the path -- asking for
        # "blocked.png" lands as "blocked.md".  Rust's with_default_extension()
        # (which would append ".md") is a second line of defence that the UI
        # cannot reach.  What is observable, and what actually matters, is that
        # no non-markdown file can be produced.
        app.click_button("New tab")
        if not wait_until(
            lambda: app.active_tab_title().startswith("Untitled "), timeout=20
        ):
            raise Failure(f"a scratch tab did not open: {app.tabs()}")
        # Clear every name this case could have produced, so the panel never
        # shows a "replace?" sheet on a re-run.
        candidates = [
            fx.extension_target,
            fx.work / "blocked.md",
            fx.work / "blocked.png.md",
        ]
        for candidate in candidates:
            if candidate.exists():
                candidate.unlink()

        app.set_editor_content("# Extension probe\n\nsaved with a forced extension\n")
        app.save_as(fx.extension_target)
        if wait_until(fx.extension_target.exists, timeout=8):
            raise Failure(
                "Save As produced a .png file -- the extension filter did not hold:\n"
                f"          {fx.extension_target}"
            )
        landed = [p for p in candidates[1:] if p.exists()]
        if not landed:
            raise Failure(
                "Save As produced no markdown file; work dir contains "
                f"{sorted(p.name for p in fx.work.iterdir())}"
            )
        body = app.read(landed[0]) or ""
        if "Extension probe" not in body:
            raise Failure(f"the saved file has the wrong body: {body!r}")
        if not wait_until(
            lambda: app.active_tab_title() == landed[0].name, timeout=20
        ):
            raise Failure(
                f"the tab did not rebind to {landed[0].name}; title is "
                f"{app.active_tab_title()!r}"
            )
        app.shot("t3-02-extension")

    group.cases.append(
        Case("T3-02", "Save As cannot produce a non-markdown file", t02)
    )

    def t03():
        # Opening through the file dialog is what records a recent file.
        app.open_file(fx.alpha)
        if not wait_until(lambda: app.find_tab("alpha.md") is not None, timeout=25):
            raise Failure(f"alpha.md did not open: {app.tabs()}")
        app.focus_tab_matching("alpha.md")
        app.keystroke("w")
        if not wait_until(lambda: app.find_tab("alpha.md") is None, timeout=20):
            raise Failure("could not close the alpha.md tab before the recent-file test")

        # Reopen it from the command palette's "Recent:" entry.
        app.keystroke("p")
        time.sleep(1.0)
        pbcopy(fx.alpha.name)
        app.keystroke("v")
        time.sleep(1.2)
        app.key_code(36)  # Return runs the highlighted result
        if not wait_until(lambda: app.find_tab("alpha.md") is not None, timeout=25):
            raise Failure(
                f"the recent entry did not reopen the file: {app.tabs()} "
                "(is the palette row highlighted?)"
            )
        title = app.focus_tab_matching("alpha.md")

        # Evidence 1: the tab is marked read-only.  The lock is a CSS ::after
        # on .tab-readonly, so it shows up in the AX name; the DOM title
        # attribute shows up in the AX description.
        if app.READ_ONLY_MARK not in title:
            raise Failure(
                f"the reopened tab is not marked read-only: title={title!r}"
            )
        description = app.button_descriptions().get(f"{title} Close tab", "")
        if "Read-only" not in description:
            print(
                f"          note: no read-only tooltip in the AX description "
                f"({description!r}); the lock marker and disk check still hold"
            )
        # The notice only lives ~3.3s, so this is recorded rather than required.
        if not app.wait_for_notification(NOTIFY_READ_ONLY, timeout=8):
            print("          note: the 'Opened read-only' notice had already expired")
        else:
            print("          saw the 'Opened read-only' notice")

        # Evidence 2: editing cannot reach the disk. A recent file has no write
        # grant (open_recent passes grant_write = false), so autosave must not
        # fire even though the buffer changed.
        disk_before = app.read(fx.alpha)
        app.set_editor_content("# Alpha edited through a read-only tab\n\nmust not persist\n")
        time.sleep(4.0)
        disk_after = app.read(fx.alpha)
        if disk_after != disk_before:
            raise Failure(
                "a recent-file (read-only) tab wrote to disk:\n"
                f"          before={disk_before!r}\n          after={disk_after!r}"
            )

        # Evidence 3: Cmd+S cannot overwrite in place, it opens Save As.
        app.keystroke("s")
        if not wait_until(app.panel_open, timeout=20):
            raise Failure("Cmd+S on a read-only tab did not open a Save As panel")
        app.dismiss_panel()
        app.ensure_no_panel()
        app.shot("t3-03-recent-readonly")

    group.cases.append(
        Case("T3-03", "a recent-file tab is read-only and never writes to disk", t03)
    )

    return group


# --------------------------------------------------------------------------- #
# Tier 4 -- multiple windows
# --------------------------------------------------------------------------- #
def _tier4(app: App, fx: Fixture) -> Group:
    group = Group("Tier 4 multi-window: workspaces / ownership / lifecycle", fresh_profile=True)

    def t01():
        # A second window must get its own workspace while the Untitled counter
        # stays shared, so the new window's first tab is NOT "Untitled 1".
        base_tabs = app.tabs()
        if base_tabs != ["Untitled 1"]:
            raise Failure(f"expected a single 'Untitled 1' before opening a window: {base_tabs}")
        app.keystroke("n", "command down, shift down")
        app.wait_for_new_window(minimum=2)
        snapshot = app.window_snapshot()
        if len(snapshot) != 2:
            raise Failure(f"Cmd+Shift+N did not produce 2 windows: {snapshot}")
        new_tabs = app.tabs(1)  # a freshly built window is frontmost
        if new_tabs != ["Untitled 2"]:
            raise Failure(
                f"the new window should start with the next shared number "
                f"(Untitled 2), got {new_tabs} (windows: {snapshot})"
            )
        if app.tabs(2) != ["Untitled 1"]:
            raise Failure(f"the original window changed: {app.tabs(2)}")

        # Each workspace keeps its own content: give both windows a marker, then
        # export from each and check the ZIP only holds that window's tab.
        app.raise_window_with_tab("Untitled 1")
        app.set_editor_content("# window one\n\nMARKER_W1\n")
        time.sleep(1.5)
        app.raise_window_with_tab("Untitled 2")
        app.focus_editor()
        pbcopy("# window two\n\nMARKER_W2\n")
        app.keystroke("v")
        time.sleep(1.5)

        for needle, marker, other in (
            ("Untitled 2", "MARKER_W2", "MARKER_W1"),
            ("Untitled 1", "MARKER_W1", "MARKER_W2"),
        ):
            app.raise_window_with_tab(needle)
            tables = app.export_zip(app.work / f"t4-01-{marker}.zip")
            body = "\n".join(tables.values())
            if marker not in body:
                raise Failure(
                    f"the {marker} window exported the wrong workspace: "
                    f"entries={list(tables)} body={body!r}"
                )
            if other in body:
                raise Failure(
                    f"the {marker} window exported the other window's tab too: "
                    f"entries={list(tables)}"
                )
        app.shot("t4-01-two-windows")

    group.cases.append(
        Case("T4-01", "Cmd+Shift+N opens a window with its own workspace", t01)
    )

    def t02():
        # A file already owned by one window is routed back to it: the second
        # window must not get a duplicate tab, and must not mint a write grant.
        app.raise_window_with_tab("Untitled 1")
        app.open_file(fx.alpha)
        if not wait_until(lambda: app.find_tab("alpha.md", 1) is not None, timeout=25):
            raise Failure(f"alpha.md did not open in the first window: {app.tabs(1)}")
        owner_tabs = app.tabs(1)

        app.raise_window_with_tab("Untitled 2")
        app.open_file(fx.alpha)
        time.sleep(3.0)
        if not wait_until(lambda: app.window_with_tab("alpha.md") == 1, timeout=20):
            raise Failure(
                "opening an owned file from the other window did not raise the "
                f"owner: {app.window_snapshot()}"
            )
        if app.find_tab("alpha.md", 2) is not None:
            raise Failure(f"the file was duplicated into the second window: {app.tabs(2)}")
        if sorted(app.tabs(1)) != sorted(owner_tabs):
            raise Failure(f"the owner window gained a duplicate tab: {owner_tabs} -> {app.tabs(1)}")
        if app.window_count() != 2:
            raise Failure(f"a third window appeared: {app.window_snapshot()}")

        # The routed tab must still be writable (the grant moved with it).
        app.focus_tab_matching("alpha.md")
        app.set_editor_content(EDIT_ALPHA)
        if not wait_until(lambda: EDIT_ALPHA in (app.read(fx.alpha) or ""), timeout=20):
            raise Failure(
                f"the routed tab lost its write grant: {app.read(fx.alpha)!r}"
            )
        app.shot("t4-02-routed")

    group.cases.append(
        Case("T4-02", "an owned file opened from another window routes to its owner", t02)
    )

    def t03():
        # Finder-style "Open With" while two windows exist: the tab must land in
        # exactly one of them, never in a brand new window.
        before = {index: tabs for index, _title, tabs in app.window_snapshot()}
        app.launch_second_instance(fx.gamma)
        if not wait_until(lambda: app.window_with_tab("gamma.md") is not None, timeout=30):
            raise Failure(f"the second instance never delivered gamma.md: {app.window_snapshot()}")
        after = app.window_snapshot()
        if len(after) != len(before):
            raise Failure(f"the open created a window: {before} -> {after}")
        holders = [index for index, _title, tabs in after if any("gamma.md" in t for t in tabs)]
        if len(holders) != 1:
            raise Failure(f"gamma.md landed in {len(holders)} windows: {after}")
        target = holders[0]
        for index, tabs in before.items():
            if index == target:
                continue
            if sorted(app.tabs(index)) != sorted(tabs):
                raise Failure(
                    f"a window other than the target changed: {tabs} -> {app.tabs(index)}"
                )
        app.shot("t4-03-second-instance")

    group.cases.append(
        Case("T4-03", "a file sent by a second instance lands in one window only", t03)
    )

    def t04():
        # Closing a scratch tab archives it (content intact) and Restore brings
        # it back into the window the restore was clicked in.
        app.raise_window_with_tab("Untitled 1")
        app.click_button("New tab")
        if not wait_until(
            lambda: app.active_tab_title().startswith("Untitled "), timeout=20
        ):
            raise Failure(f"a scratch tab did not open: {app.tabs()}")
        archived = app.active_tab_title()
        app.set_editor_content("# archive me\n\nARCHIVE_ROUNDTRIP\n")
        time.sleep(1.5)
        app.keystroke("w")
        if not wait_until(lambda: app.find_tab(archived) is None, timeout=20):
            raise Failure(f"Cmd+W did not close {archived!r}: {app.tabs()}")

        app.open_archive()
        try:
            texts = app.static_texts()
            if archived not in texts:
                raise Failure(f"the archive does not list {archived!r}: {texts[:12]}")
            if not any("ARCHIVE_ROUNDTRIP" in text for text in texts):
                raise Failure(f"the archive lost the tab content: {texts[:12]}")
            app.restore_from_archive()
        finally:
            app.close_archive()
        if not wait_until(lambda: app.find_tab(archived) is not None, timeout=20):
            raise Failure(f"Restore did not bring {archived!r} back: {app.tabs()}")
        app.focus_tab_matching(archived)
        app.assert_buffer(archived, "# archive me\n\nARCHIVE_ROUNDTRIP\n", "restored tab")

        # An *empty* scratch tab is discarded instead of archived.
        app.click_button("New tab")
        if not wait_until(
            lambda: app.active_tab_title().startswith("Untitled "), timeout=20
        ):
            raise Failure(f"a scratch tab did not open: {app.tabs()}")
        empty_tab = app.active_tab_title()
        app.keystroke("w")
        if not wait_until(lambda: app.find_tab(empty_tab) is None, timeout=20):
            raise Failure(f"Cmd+W did not close {empty_tab!r}: {app.tabs()}")
        app.open_archive()
        try:
            texts = app.static_texts()
            if empty_tab in texts:
                raise Failure(f"an empty scratch tab was archived: {texts[:12]}")
        finally:
            app.close_archive()
        app.shot("t4-04-archive")

    group.cases.append(
        Case("T4-04", "a closed tab is archived with its content and can be restored", t04)
    )

    def t05():
        app.raise_window_with_tab("Untitled 1")
        app.open_settings()
        before = app.settings_font_size()
        if before is None:
            raise Failure("the Editor Font Size input was not readable")
        app.settings_set_font_size("29")
        app.close_settings()
        app.quit()
        app.launch()
        app.open_settings()
        after = app.settings_font_size()
        app.close_settings()
        if after != "29":
            raise Failure(
                f"the editor font size did not survive the restart: {before!r} -> {after!r}"
            )
        app.shot("t4-05-settings")

    group.cases.append(
        Case("T4-05", "a settings change survives a restart", t05)
    )

    def t06():
        # Menu and keyboard actions follow the focused window only.  A relaunch
        # in T4-05 left a single window, so open a second one first.
        if app.window_count() < 2:
            app.keystroke("n", "command down, shift down")
            app.wait_for_new_window(minimum=2)
        front_before = list(app.tabs(1))
        other_before = list(app.tabs(2))
        other_active = app.active_tab_title(2)

        app.keystroke("n")
        if not wait_until(lambda: len(app.tabs(1)) == len(front_before) + 1, timeout=25):
            raise Failure(
                f"Cmd+N did not add a tab to the focused window: "
                f"{front_before} -> {app.tabs(1)}"
            )
        added = [tab for tab in app.tabs(1) if tab not in front_before]
        if len(added) != 1:
            raise Failure(f"could not tell which tab Cmd+N added: {app.tabs(1)}")
        if added[0] in other_before:
            raise Failure(
                f"Cmd+N reused a number that is live in the other window: {added[0]!r}"
            )
        if sorted(app.tabs(2)) != sorted(other_before):
            raise Failure(
                f"Cmd+N leaked into the other window: {other_before} -> {app.tabs(2)}"
            )

        app.keystroke("w")
        if not wait_until(lambda: app.find_tab(added[0]) is None, timeout=25):
            raise Failure(f"Cmd+W did not close {added[0]!r}: {app.tabs(1)}")
        if sorted(app.tabs(1)) != sorted(front_before):
            raise Failure(
                f"the focused window did not return to its previous tabs: "
                f"{front_before} -> {app.tabs(1)}"
            )
        if sorted(app.tabs(2)) != sorted(other_before):
            raise Failure(
                f"Cmd+W leaked into the other window: {other_before} -> {app.tabs(2)}"
            )
        if app.active_tab_title(2) != other_active:
            raise Failure(
                f"the other window's active tab changed: {other_active!r} -> "
                f"{app.active_tab_title(2)!r}"
            )
        app.shot("t4-06-scoped-menu")

    group.cases.append(
        Case("T4-06", "Cmd+N and Cmd+W only touch the focused window", t06)
    )

    def t07():
        # Two windows: the front one is closed with another still alive, so the
        # renderer is asked to stand down.  It archives the window's non-empty
        # scratch tabs and deletes its workspace -- the surviving window must
        # not be disturbed.  Closing the *last* window is not intercepted, so
        # that workspace survives for the Dock-style reopen.
        if app.window_count() != 2:
            raise Failure(f"expected two windows before closing one: {app.window_snapshot()}")

        app.click_button("New tab")  # in the frontmost window
        if not wait_until(
            lambda: app.active_tab_title().startswith("Untitled "), timeout=20
        ):
            raise Failure(f"a scratch tab did not open: {app.tabs(1)}")
        doomed_tab = app.active_tab_title()
        app.set_editor_content("# doomed window\n\nDOOMED_MARKER\n")
        time.sleep(1.5)
        survivor_tabs = list(app.tabs(2))
        if doomed_tab in survivor_tabs:
            raise Failure("the two windows share a tab title; the case cannot tell them apart")

        app.keystroke("w", "command down, shift down")
        if not wait_until(lambda: app.window_count() == 1, timeout=25):
            raise Failure(f"Cmd+Shift+W did not close the window: {app.window_snapshot()}")
        if not app.alive():
            raise Failure("the app quit when one of two windows was closed")
        if sorted(app.tabs(1)) != sorted(survivor_tabs):
            raise Failure(
                f"the surviving window changed: {survivor_tabs} -> {app.tabs(1)}"
            )
        app.open_archive()
        try:
            texts = app.static_texts()
            if doomed_tab not in texts:
                raise Failure(
                    f"the closed window's scratch tab was not archived: {texts[:12]}"
                )
        finally:
            app.close_archive()

        # Closing the last window leaves a windowless process (macOS behaviour);
        # the Dock-style reopen must bring that workspace back, not a stray one.
        app.keystroke("w", "command down, shift down")
        if not wait_until(lambda: app.window_count() == 0, timeout=25):
            raise Failure(f"the last window did not close: {app.window_snapshot()}")
        if not app.alive():
            raise Failure("the app quit with the last window instead of staying alive")
        app.reopen_with_launch_services()
        if not wait_until(lambda: app.window_count() >= 1, timeout=45):
            raise Failure("no window came back after the Dock-style reopen")
        if not wait_until(lambda: app.tabs(1) != [], timeout=40):
            raise Failure("the reopened window never rendered its tab bar")
        if sorted(app.tabs(1)) != sorted(survivor_tabs):
            raise Failure(
                f"the reopen restored the wrong workspace: expected {survivor_tabs}, "
                f"got {app.tabs(1)}"
            )
        if app.window_count() != 1:
            raise Failure(f"the reopen stacked extra windows: {app.window_snapshot()}")
        app.shot("t4-07-reopen")

    group.cases.append(
        Case("T4-07", "closing windows keeps the app alive and reopen restores it", t07)
    )

    return group


def build_groups(app: App, fx: Fixture) -> list[Group]:
    return [_tier1(app, fx), _tier2(app, fx), _tier3(app, fx), _tier4(app, fx)]
