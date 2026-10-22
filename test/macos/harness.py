"""Reusable macOS UI-automation harness for Sainte Devote.

Everything here is app-agnostic plumbing: AppleScript execution, the
accessibility (AX) tree, native Open/Save panel driving, clipboard-based text
entry and filesystem assertions.  The test cases themselves live in
``scenarios.py``.

Design notes that cost real debugging time -- please read before changing:

* The app is driven through the *real* menu bar / keyboard shortcuts, so a
  test exercises the same IPC path a user does.
* Text is never typed with ``keystroke "some text"``: the machine may have an
  IME active (Kotoji/Japanese here) which rewrites synthetic characters.  Use
  the clipboard and paste instead, which bypasses input methods entirely.
* The native Open/Save panels are presented as *sheets*.  If a panel cannot
  accept the requested target it stays open and silently swallows every later
  keystroke, turning one failure into a wall of fake failures.  Every step
  therefore starts by proving no panel is open (``ensure_no_panel``).
* AppleScript list-to-string coercion uses a separator we cannot control, so
  lists are joined with ``linefeed`` and split in Python.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import time
import zipfile
from dataclasses import dataclass, field
from pathlib import Path

# Repository root: .../test/macos/harness.py -> .../
REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_APP = REPO_ROOT / "src-tauri/target/release/bundle/macos/Sainte Devote.app"

# AX path down to the tab bar container inside the web view.  Append the window
# index ("... of window 1") at each use site.
TABS_AX = "UI element 1 of scroll area 1 of group 1 of group 1"
# Monaco exposes a hidden textarea.  Focusing it is what puts the caret in the
# model, so synthetic paste/keystrokes land in the buffer.
MONACO_AX = f"text area 1 of group 1 of {TABS_AX}"

NOTIFY_CONFLICT = "changed on disk"
NOTIFY_DELETED = "deleted on disk"
NOTIFY_READ_ONLY = "Opened read-only"
ACTION_RELOAD = "Reload from disk"
ACTION_KEEP = "Keep my version"

# Multi-window / settings / archive anchors.
ARCHIVE_BUTTON = "Archived Tabs"
SETTINGS_FONT_FIELD = "Editor Font Size (px)"


class Failure(Exception):
    """One test assertion failed; that case aborts, later cases continue."""


# --------------------------------------------------------------------------- #
# AppleScript plumbing
# --------------------------------------------------------------------------- #
def osa(script: str, timeout: float = 30.0) -> str:
    """Run an AppleScript via stdin and return its stripped stdout."""
    proc = subprocess.run(
        ["osascript", "-"],
        input=script,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
    )
    if proc.returncode != 0:
        raise Failure(
            f"osascript failed: {(proc.stderr or proc.stdout).strip() or 'unknown error'}"
        )
    return proc.stdout.strip()


def try_osa(script: str, timeout: float = 30.0) -> str | None:
    """Run an AppleScript, returning None instead of raising (for probing)."""
    try:
        return osa(script, timeout=timeout)
    except Exception:
        return None


def wait_until(predicate, timeout: float = 12.0, interval: float = 0.25) -> bool:
    """Poll ``predicate`` until it returns truthy or ``timeout`` elapses."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            if predicate():
                return True
        except Failure:
            pass
        time.sleep(interval)
    return False


def lines(raw: str | None) -> list[str]:
    """Split a linefeed-joined AppleScript result into clean items."""
    return [item.strip() for item in (raw or "").split("\n") if item.strip()]


def pbcopy(text: str) -> None:
    subprocess.run(
        ["pbcopy"], input=text, text=True, encoding="utf-8", check=True
    )


def accessibility_problem() -> str | None:
    """Return a human-readable reason when UI scripting is unavailable."""
    if sys.platform != "darwin":
        return "this harness drives the macOS accessibility API and only runs on macOS"
    proc = subprocess.run(
        ["osascript", "-e", 'tell application "System Events" to return 1'],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode == 0:
        return None
    message = (proc.stderr or proc.stdout).strip()
    if "-25211" in message or "assistive" in message or "not allowed" in message:
        return (
            "Accessibility permission is required: add your terminal (or the "
            "process running this script) under System Settings > Privacy & "
            "Security > Accessibility, then re-run.\n"
            f"  osascript said: {message}"
        )
    return f"System Events is not usable here: {message}"


# --------------------------------------------------------------------------- #
# application under test
# --------------------------------------------------------------------------- #
@dataclass
class App:
    """Drives one installed/built Sainte Devote bundle."""

    bundle: Path
    home: Path
    work: Path
    shots: Path
    binary: Path | None = None
    proc: subprocess.Popen | None = None
    shot_index: int = 0

    def __post_init__(self) -> None:
        if self.binary is None:
            self.binary = self._find_binary()
        self.process = self.binary.name

    def _find_binary(self) -> Path:
        macos_dir = self.bundle / "Contents/MacOS"
        if not macos_dir.is_dir():
            raise Failure(
                f"{self.bundle} is not an app bundle -- build it first "
                "(pnpm build:mac) or pass --app"
            )
        executables = [
            p for p in sorted(macos_dir.iterdir()) if p.is_file() and os.access(p, os.X_OK)
        ]
        if not executables:
            raise Failure(f"no executable inside {macos_dir}")
        # The Cargo binary name, not the product name in the bundle title.
        return executables[0]

    # -- lifecycle ---------------------------------------------------------- #
    def launch(self, extra_args: tuple[str, ...] = (), timeout: float = 45.0) -> None:
        if self.proc is not None:
            raise Failure("app is already running; call quit() first")
        env = dict(os.environ, CFFIXED_USER_HOME=str(self.home))
        self.proc = subprocess.Popen(
            [str(self.binary), *extra_args],
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if not wait_until(lambda: self.window_count() >= 1, timeout=timeout):
            raise Failure(f"app did not present a window within {timeout:.0f}s")
        self.focus()
        # The AX tree is only populated once the web view has loaded Monaco;
        # tab buttons are the last thing to appear.
        if not wait_until(lambda: len(self.tabs()) >= 1, timeout=timeout):
            raise Failure("app did not render a tab bar")
        self.ensure_no_panel()

    def quit(self, timeout: float = 15.0) -> None:
        if self.proc is None:
            self._kill_strays()
            return
        try:
            self.keystroke("q")
        except Failure:
            pass
        if not wait_until(lambda: self.window_count() == 0, timeout=timeout):
            self.proc.kill()
        try:
            self.proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.proc = None
        self._kill_strays()

    def _kill_strays(self) -> None:
        """A leftover instance would drive a *different* profile."""
        for _ in range(20):
            running = subprocess.run(
                ["pgrep", "-x", self.process], capture_output=True
            ).stdout
            if not running.strip():
                return
            subprocess.run(["pkill", "-x", self.process])
            time.sleep(0.4)

    def new_profile(self, home: Path) -> None:
        """Restart against a different (empty) home so scratch tabs reset."""
        self.quit()
        self.home = home
        home.mkdir(parents=True, exist_ok=True)

    def alive(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def focus(self) -> None:
        try_osa(
            f'tell application "System Events" to tell process "{self.process}" '
            "to set frontmost to true"
        )
        time.sleep(0.3)

    def reopen_with_launch_services(self) -> None:
        """Reopen the way a Dock click does (macOS Reopen event)."""
        subprocess.Popen(
            ["open", "-a", str(self.bundle)],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    def launch_second_instance(self, *args: str | Path) -> None:
        """Hand paths to the running app the way Finder's Open With does.

        The second process hits the single-instance plugin, which forwards argv
        to the live instance; that path runs ``session::resolve_argv_paths`` and
        therefore exercises the real validators instead of the file picker.
        """
        subprocess.Popen(
            [str(self.binary), *[str(a) for a in args]],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )

    # -- native Open / Save panels ------------------------------------------ #
    def sheet_count(self) -> int:
        out = try_osa(
            f"""tell application "System Events" to tell process "{self.process}"
                set total to 0
                repeat with w in windows
                    try
                        set total to total + (count of sheets of w)
                    end try
                end repeat
                return total
            end tell"""
        )
        return int(out) if out and out.isdigit() else 0

    def panel_open(self) -> bool:
        return self.sheet_count() > 0

    def dismiss_panel(self, attempts: int = 5) -> bool:
        for _ in range(attempts):
            if not self.panel_open():
                return True
            try_osa('tell application "System Events" to key code 53')
            time.sleep(0.6)
        return not self.panel_open()

    def ensure_no_panel(self) -> None:
        if not self.panel_open():
            return
        if not self.dismiss_panel():
            raise Failure("a native panel is stuck open and could not be dismissed")
        self.focus()

    def panel_choose(self, path: Path, must_close: bool = True, timeout: float = 40.0) -> bool:
        """Go to folder -> paste path -> Return, then confirm.

        Returns True once the panel is gone.  ``must_close=False`` tolerates a
        panel that refuses the target (a symlink the picker will not select is
        a legitimate outcome for the caller) and just dismisses it.
        """
        pbcopy(str(path))
        self.focus()
        osa(
            f"""tell application "System Events" to tell process "{self.process}"
                delay 0.4
                keystroke "g" using {{command down, shift down}}
                delay 1.2
                keystroke "v" using command down
                delay 0.8
                key code 36
                delay 1.8
                key code 36
            end tell""",
            timeout=90,
        )
        if not must_close:
            self.dismiss_panel()
            return not self.panel_open()
        if wait_until(lambda: not self.panel_open(), timeout=timeout):
            time.sleep(0.6)
            return True
        # The default button sometimes needs a second nudge.
        try_osa('tell application "System Events" to key code 36')
        if wait_until(lambda: not self.panel_open(), timeout=8):
            return True
        self.dismiss_panel()
        return not self.panel_open()

    # -- accessibility tree -------------------------------------------------- #
    def windows(self) -> list[str]:
        out = try_osa(
            'tell application "System Events" to tell process '
            f'"{self.process}" to get name of every window'
        )
        return [w.strip() for w in (out or "").split(",") if w.strip()]

    def window_count(self) -> int:
        out = try_osa(
            f'tell application "System Events" to tell process "{self.process}" '
            "to count windows"
        )
        return int(out) if out and out.isdigit() else 0

    def title(self, window: int = 1) -> str:
        names = self.windows()
        if not names:
            raise Failure("no window to read a title from")
        if window > len(names):
            raise Failure(f"window {window} does not exist (have {len(names)})")
        return names[window - 1]

    def active_tab_title(self, window: int = 1) -> str:
        return self.title(window).removesuffix(" — Sainte Devote")

    def _buttons(self, window: int) -> list[str]:
        """Names of every button the web view exposes.

        This covers the tab bar *and* the action buttons of a notification
        banner: the banner is a sibling group of the tab bar rather than a
        child, but its buttons still land in the same ``buttons`` collection
        (verified: the count goes from 6 to 8 while a conflict banner is up).

        Do **not** try ``every button of entire contents`` -- it raises
        AppleScript error -1700 and a ``try`` block would silently hide it.
        """
        out = try_osa(
            f"""tell application "System Events" to tell process "{self.process}"
                set acc to ""
                repeat with b in (buttons of {TABS_AX} of window {window})
                    try
                        set nm to name of b
                        if nm is not missing value then
                            set acc to acc & (nm as string) & linefeed
                        end if
                    end try
                end repeat
                return acc
            end tell"""
        )
        return lines(out)

    def tabs(self, window: int = 1) -> list[str]:
        """Tab titles, read from the tab bar's "<title> Close tab" buttons.

        A read-only tab carries a trailing "🔒" from a CSS ``::after`` rule
        (main.css ``.tab-readonly span:first-child::after``), so titles must be
        matched with :meth:`find_tab` rather than by equality.
        """
        return [
            b.removesuffix(" Close tab")
            for b in self._buttons(window)
            if b.endswith(" Close tab")
        ]

    READ_ONLY_MARK = "🔒"

    def find_tab(self, needle: str, window: int = 1) -> str | None:
        """The full tab title containing ``needle``, or None.

        Titles may carry the read-only lock, e.g. ``alpha.md🔒``.
        """
        for title in self.tabs(window):
            if needle in title:
                return title
        return None

    def focus_tab_matching(self, needle: str, window: int = 1, timeout: float = 15.0) -> str:
        """Focus the tab containing ``needle`` and return its full title."""
        title = self.find_tab(needle, window)
        if title is None:
            raise Failure(
                f"no tab matching {needle!r}; open tabs: {self.tabs(window)}"
            )
        self.focus_tab(title, window=window, timeout=timeout)
        return title

    def button_names(self, window: int = 1) -> list[str]:
        return self._buttons(window)

    def button_descriptions(self, window: int = 1) -> dict[str, str]:
        """AX ``description`` per button, which carries the DOM ``title`` tooltip.

        Read-only tabs are the interesting case: ``addTab`` only sets
        ``title`` on a tab when it is read-only, so an empty description means
        a normal (writable) tab.
        """
        out = try_osa(
            f"""tell application "System Events" to tell process "{self.process}"
                set acc to ""
                repeat with b in (buttons of {TABS_AX} of window {window})
                    try
                        set nm to name of b
                        set dc to ""
                        try
                            set dc to (description of b) as string
                        end try
                        if nm is not missing value then
                            set acc to acc & (nm as string) & tab & dc & linefeed
                        end if
                    end try
                end repeat
                return acc
            end tell"""
        )
        pairs: dict[str, str] = {}
        for line in lines(out):
            name, _, desc = line.partition("\t")
            pairs[name.strip()] = desc.strip()
        return pairs

    def static_texts(self, window: int = 1) -> list[str]:
        """Text the web view exposes: the palette placeholder plus banner copy.

        A notification banner is a group under the tab container and its text
        is a direct child, so one level of descent reaches it.  The editor
        buffer sits deeper (container > group > text area > group > text) and
        is deliberately not collected here -- Monaco only keeps virtualised
        rows in the tree, so ``assert_buffer`` uses the ZIP export instead.

        Plain notifications auto-dismiss after ~3.3s (renderer.js
        ``showNotification``), so callers should poll with
        :meth:`wait_for_notification` rather than read once.
        """
        out = try_osa(
            f"""tell application "System Events" to tell process "{self.process}"
                set acc to ""
                try
                    repeat with t in (static texts of {TABS_AX} of window {window})
                        set acc to acc & ((value of t) as string) & linefeed
                    end repeat
                end try
                set n to 0
                try
                    set n to count of groups of {TABS_AX} of window {window}
                end try
                repeat with i from 1 to n
                    try
                        repeat with t in (static texts of group i of {TABS_AX} of window {window})
                            set acc to acc & ((value of t) as string) & linefeed
                        end repeat
                    end try
                end repeat
                return acc
            end tell""",
            timeout=60,
        )
        return lines(out)

    def has_notification(self, needle: str) -> bool:
        return any(needle in text for text in self.static_texts())

    def wait_for_notification(
        self, needle: str, timeout: float = 20.0, poll: float = 0.4
    ) -> bool:
        """Poll for a transient notification.

        ``showNotification`` removes the element 3s after it appears, so a
        single read is a coin flip; a fast poll is not.
        """
        deadline = time.monotonic() + timeout
        while True:
            if self.has_notification(needle):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(poll)

    def click_button(self, name: str, window: int = 1) -> None:
        """Click a web-view button by name.

        Used for both tab-bar buttons ("New tab") and banner actions
        ("Reload from disk" / "Keep my version").
        """
        self.focus()
        osa(
            f"""tell application "System Events" to tell process "{self.process}"
                click button "{name}" of {TABS_AX} of window {window}
            end tell"""
        )
        time.sleep(0.5)

    def focus_editor(self, window: int = 1) -> None:
        """Put the caret in Monaco's model through the accessibility tree.

        Coordinate clicks are not an option: System Events ``click at`` fails
        with error -25208 against this web view.
        """
        osa(
            f"""tell application "System Events" to tell process "{self.process}"
                set frontmost to true
                delay 0.3
                set focused of {MONACO_AX} of window {window} to true
            end tell"""
        )
        time.sleep(0.4)

    # -- multi-window -------------------------------------------------------- #
    def window_snapshot(self) -> list[tuple[int, str, list[str]]]:
        """``[(index, title, tabs)]`` for every window, front to back.

        The AX order is z-order: ``window 1`` is the frontmost, and a window
        that gets raised moves to the front.  Never cache an index across a
        raise -- re-read this instead.
        """
        snapshot: list[tuple[int, str, list[str]]] = []
        for index in range(1, self.window_count() + 1):
            try:
                name = osa(
                    f'tell application "System Events" to tell process '
                    f'"{self.process}" to get name of window {index}'
                )
            except Failure:
                break
            snapshot.append((index, name, self.tabs(index)))
        return snapshot

    def window_with_tab(self, needle: str) -> int | None:
        """Index of the frontmost window holding a tab matching ``needle``.

        An exact tab title wins over a substring hit, so raising "Untitled 1"
        cannot accidentally pick the window that shows "Untitled 10".
        """
        for exact in (True, False):
            for index, _title, tabs in self.window_snapshot():
                for tab in tabs:
                    if (tab == needle) if exact else (needle in tab):
                        return index
        return None

    def raise_window(self, index: int, settle: float = 0.8) -> None:
        """Bring ``window index`` to the front.

        AXRaise is what the system uses for a Dock/Window-menu activation;
        afterwards the window is ``window 1`` and keystrokes, menu clicks and
        ``menu_target()`` on the Rust side all follow it (verified: a
        ``File > New Tab`` after a raise added the tab to the raised window).
        """
        osa(
            f"""tell application "System Events" to tell process "{self.process}"
                set frontmost to true
                delay 0.2
                perform action "AXRaise" of window {index}
            end tell"""
        )
        time.sleep(settle)

    def raise_window_with_tab(self, needle: str, timeout: float = 20.0) -> None:
        """Raise the window that holds ``needle`` and wait until it is front."""
        index = self.window_with_tab(needle)
        if index is None:
            raise Failure(
                f"no window holds a tab matching {needle!r}: {self.window_snapshot()}"
            )
        if index != 1:
            self.raise_window(index)
        if not wait_until(lambda: self.window_with_tab(needle) == 1, timeout=timeout):
            raise Failure(
                f"the window holding {needle!r} never came to the front: "
                f"{self.window_snapshot()}"
            )

    def wait_for_new_window(self, minimum: int = 2, timeout: float = 40.0) -> None:
        """Wait for a window count and for every window's tab bar to populate.

        A freshly built window is frontmost but exposes an empty AX tree for a
        few seconds; reading its tabs too early looks like "no tabs".
        """
        if not wait_until(lambda: self.window_count() >= minimum, timeout=timeout):
            raise Failure(f"expected {minimum} windows, got {self.window_count()}")
        if not wait_until(lambda: self.tabs(1) != [], timeout=timeout):
            raise Failure("the new window never rendered its tab bar")

    # -- settings modal ------------------------------------------------------ #
    def open_settings(self) -> None:
        self.keystroke(",")
        time.sleep(1.4)

    def close_settings(self) -> None:
        self.key_code(53)
        time.sleep(0.8)

    def _settings_field(self, action: str, window: int = 1) -> str | None:
        """Run ``action`` against the Editor Font Size input.

        The modal is not a flat child of the window, so the element is located
        with an ``entire contents`` walk, filtered by class.  The walk must be
        assigned to a variable first: inlining ``entire contents`` straight
        into ``repeat with e in (...)`` finds nothing at all (measured).
        ``set value`` is silently ignored by this web view, which is why the
        setter focuses the field and pastes.
        """
        out = try_osa(
            f"""tell application "System Events" to tell process "{self.process}"
                set all to entire contents of window {window}
                repeat with e in all
                    try
                        if (class of e is text field) and ((name of e as string) is "{SETTINGS_FONT_FIELD}") then
                            {action}
                        end if
                    end try
                end repeat
                return "not-found"
            end tell""",
            timeout=60,
        )
        if out is None or out == "not-found":
            return None
        return out

    def settings_font_size(self, window: int = 1) -> str | None:
        """The Editor Font Size value as AX reports it, or None when closed."""
        return self._settings_field("return (value of e as string)", window)

    def settings_set_font_size(self, value: str, window: int = 1) -> None:
        if self._settings_field("set focused of e to true\n return \"focused\"", window) is None:
            raise Failure(f"the {SETTINGS_FONT_FIELD!r} input is not on screen")
        pbcopy(value)
        self.keystroke("a")
        self.keystroke("v")
        time.sleep(0.6)
        got = self.settings_font_size(window)
        if got != value:
            raise Failure(
                f"the settings field did not take {value!r} (AX reports {got!r})"
            )

    # -- archive (trash) ----------------------------------------------------- #
    def archive_open(self, window: int = 1) -> bool:
        """True while the archive popover is showing ("Clear All" is inside)."""
        return "Clear All" in self.button_names(window)

    def open_archive(self, window: int = 1) -> None:
        self.click_button(ARCHIVE_BUTTON, window=window)
        time.sleep(1.2)

    def close_archive(self, window: int = 1) -> None:
        if self.archive_open(window):
            self.click_button("Close", window=window)
            time.sleep(0.8)

    def restore_from_archive(self, window: int = 1) -> None:
        if "Restore" not in self.button_names(window):
            raise Failure(
                f"no Restore button in the archive popover; buttons="
                f"{self.button_names(window)}"
            )
        self.click_button("Restore", window=window)
        time.sleep(2.0)

    # -- input --------------------------------------------------------------- #
    def menu(self, menu: str, item: str) -> None:
        self.ensure_no_panel()
        self.focus()
        osa(
            f"""tell application "System Events" to tell process "{self.process}"
                click menu item "{item}" of menu 1 of menu bar item "{menu}" of menu bar 1
            end tell"""
        )
        time.sleep(0.6)

    def keystroke(self, keys: str, modifiers: str = "command down") -> None:
        self.ensure_no_panel()
        self.focus()
        osa(
            f"""tell application "System Events" to tell process "{self.process}"
                keystroke "{keys}" using {{{modifiers}}}
            end tell"""
        )
        time.sleep(0.4)

    def key_code(self, code: int) -> None:
        self.focus()
        try_osa(f'tell application "System Events" to key code {code}')
        time.sleep(0.4)

    def set_editor_content(self, text: str) -> None:
        """Replace the active tab's whole buffer with ``text``.

        Clipboard based (IME proof) and select-all + paste, so the result is
        exactly ``text`` rather than depending on where the caret happened to be.
        """
        pbcopy(text)
        self.ensure_no_panel()
        self.focus_editor()
        self.keystroke("a")
        self.keystroke("v")

    def append_to_editor(self, text: str) -> None:
        """Paste at the caret without touching the selection (race tests)."""
        pbcopy(text)
        self.focus()
        osa(
            f"""tell application "System Events" to tell process "{self.process}"
                keystroke "v" using command down
            end tell"""
        )

    # -- evidence ------------------------------------------------------------ #
    def shot(self, name: str, label: str = "") -> Path:
        self.shot_index += 1
        target = self.shots / f"{self.shot_index:02d}-{name}.png"
        geom = try_osa(
            f"""tell application "System Events" to tell process "{self.process}"
                tell window 1
                    set p to position
                    set s to size
                    return ((item 1 of p) as string) & "," & ((item 2 of p) as string) & "," & ((item 1 of s) as string) & "," & ((item 2 of s) as string)
                end tell
            end tell"""
        )
        args = ["screencapture", "-x"]
        if geom and geom.count(",") == 3:
            args += ["-R", geom.replace(",", ",")]
        args.append(str(target))
        subprocess.run(args, check=False)
        return target

    # -- filesystem ---------------------------------------------------------- #
    @staticmethod
    def read(path: Path) -> str | None:
        try:
            return path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            return None

    def export_zip(self, target: Path) -> dict[str, str]:
        """File > Export All Tabs (.zip) -> ``{filename: markdown}``.

        This is the only way to read back the contents of *unsaved* tabs, since
        the editor buffer is not exposed through the accessibility tree.  The
        export covers the **frontmost** window, so raise the window of interest
        first (``raise_window_with_tab``) before calling this.
        """
        if target.exists():
            target.unlink()
        extract = target.with_suffix("")
        if extract.exists():
            shutil.rmtree(extract)
        self.menu("File", "Export All Tabs (.zip)")
        if not self.panel_choose(target, timeout=45):
            raise Failure("the export panel never closed")
        if not wait_until(target.exists, timeout=25):
            raise Failure(f"export produced no file at {target.name}")
        time.sleep(0.8)
        with zipfile.ZipFile(target) as zf:
            zf.extractall(extract)
        return {
            p.name: p.read_text(encoding="utf-8") for p in sorted(extract.rglob("*.md"))
        }

    @staticmethod
    def zip_entry_for(tab_title: str, tables: dict[str, str]) -> str | None:
        """``exportAllTabs`` names entries ``<tab title>.md`` (spaces -> "_")."""
        stem = tab_title.strip().replace(" ", "_").replace("/", "_")
        for candidate in (f"{stem}.md", f"{stem}_1.md", f"{stem}_2.md"):
            if candidate in tables:
                return tables[candidate]
        return None

    def assert_buffer(self, tab_title: str, expected: str, label: str) -> None:
        tables = self.export_zip(self.work / "buffer-check.zip")
        actual = self.zip_entry_for(tab_title, tables)
        if actual != expected:
            raise Failure(
                f"{label}: buffer mismatch\n"
                f"          expected: {expected!r}\n"
                f"          actual:   {actual!r}\n"
                f"          zip entries: {list(tables)}"
            )

    def buffer_contains(self, tab_title: str, needle: str) -> bool:
        tables = self.export_zip(self.work / "buffer-probe.zip")
        body = self.zip_entry_for(tab_title, tables) or ""
        return needle in body

    # -- convenience --------------------------------------------------------- #
    def focus_tab(self, title: str, window: int = 1, timeout: float = 15.0) -> None:
        """Switch to ``title``, failing clearly when the tab is not there.

        Note the asymmetry between the two titles: the AX tab-button name
        carries the read-only lock ("alpha.md🔒", from a CSS ``::after``), while
        the window title is built from ``tabData[tabId].title`` and has no
        lock.  Compare with the lock stripped so a read-only tab does not look
        like a failed click.
        """
        if title not in self.tabs(window):
            raise Failure(f"tab {title!r} is missing; open tabs: {self.tabs(window)}")
        plain = title.replace(self.READ_ONLY_MARK, "")
        if self.active_tab_title(window).replace(self.READ_ONLY_MARK, "") == plain:
            return
        self.click_button(f"{title} Close tab", window=window)
        if not wait_until(
            lambda: self.active_tab_title(window).replace(self.READ_ONLY_MARK, "")
            == plain,
            timeout=timeout,
        ):
            raise Failure(
                f"clicked the {title!r} tab but the window title is now "
                f"{self.active_tab_title(window)!r}"
            )

    def open_file(self, path: Path, timeout: float = 45.0) -> None:
        self.menu("File", "Open File...")
        if not self.panel_choose(path, timeout=timeout):
            raise Failure(f"the open panel never closed while opening {path.name}")

    def save_as(self, path: Path, timeout: float = 45.0) -> None:
        if path.exists():
            path.unlink()  # avoid a "replace?" confirmation step
        self.menu("File", "Save As...")
        if not self.panel_choose(path, timeout=timeout):
            raise Failure(f"the save panel never closed while saving {path.name}")

    def recover(self) -> None:
        """Get back to "one window, at least one tab, no modal panel"."""
        if not self.alive():
            self.launch()
            return
        self.ensure_no_panel()
        if self.window_count() == 0:
            self.reopen_with_launch_services()
            if not wait_until(lambda: self.window_count() >= 1, timeout=40):
                raise Failure("could not bring a window back after a failure")
        self.focus()
        if not self.tabs():
            self.click_button("New tab")
        self.ensure_no_panel()


@dataclass
class Results:
    """Outcome log shared by the runner and the report.

    ``status`` is one of ``PASS`` / ``FAIL`` / ``INFO``; ``INFO`` marks an
    advisory case that did not reproduce, which never fails the run.
    """

    entries: list[tuple[str, str, str, str]] = field(default_factory=list)

    def add(self, case_id: str, title: str, status: str, detail: str = "") -> None:
        self.entries.append((case_id, title, status, detail))

    @property
    def failed(self) -> list[tuple[str, str, str, str]]:
        return [entry for entry in self.entries if entry[2] == "FAIL"]

    @property
    def passed_count(self) -> int:
        return sum(1 for entry in self.entries if entry[2] == "PASS")
