#!/usr/bin/env python3
"""Run the Sainte Devote macOS end-to-end suite against a built .app.

    python3 test/macos/verify_e2e.py                 # everything
    python3 test/macos/verify_e2e.py --tier 1        # one tier
    python3 test/macos/verify_e2e.py --only T2-02    # one case
    python3 test/macos/verify_e2e.py --keep          # keep the work dir

Prerequisites
-------------
* macOS, Python 3.10+ (standard library only)
* the app built: ``pnpm build:mac`` (or pass ``--app /path/to/Sainte Devote.app``)
* Accessibility permission for whatever runs this script (System Settings >
  Privacy & Security > Accessibility)

Isolation
---------
The app is launched with ``CFFIXED_USER_HOME`` pointing at a throwaway
directory, so scratch tabs (IndexedDB), recent files and preferences never touch
the real profile.  All fixture files live in a temp work directory.  Everything
is deleted on success and kept for inspection on failure.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import scenarios  # noqa: E402
from harness import DEFAULT_APP, App, Failure, Results, accessibility_problem  # noqa: E402


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument(
        "--app",
        type=Path,
        default=DEFAULT_APP,
        help=f"path to the .app bundle (default: {DEFAULT_APP})",
    )
    parser.add_argument("--tier", default="", help="only run tiers containing this text")
    parser.add_argument("--only", default="", help="only run cases whose id contains this")
    parser.add_argument("--keep", action="store_true", help="keep the work dir")
    parser.add_argument(
        "--keep-shots",
        action="store_true",
        help="keep screenshots even when everything passes",
    )
    parser.add_argument(
        "--no-build-check",
        action="store_true",
        help="skip the 'is the app built?' preflight",
    )
    return parser.parse_args()


def preflight(app_path: Path) -> int:
    problem = accessibility_problem()
    if problem:
        print(f"preflight failed: {problem}", file=sys.stderr)
        return 2
    if not app_path.exists():
        print(
            f"preflight failed: {app_path} does not exist.\n"
            "Build it first with: pnpm build:mac",
            file=sys.stderr,
        )
        return 2
    return 0


def run_group(
    app: App, group: scenarios.Group, results: Results, base: Path, index: int
) -> None:
    if group.fresh_profile:
        # One directory per group, and wipe it first: a stale profile would
        # carry the previous group's scratch tabs and recent files over, which
        # is exactly the determinism this isolation is meant to provide.
        home = base / f"profile-{index}"
        if home.exists():
            shutil.rmtree(home)
        app.new_profile(home)
        app.launch()
    else:
        app.recover()

    print(f"\n{'=' * 72}\n{group.name}\n{'=' * 72}", flush=True)
    for case in group.cases:
        label = f"{case.id} {case.title}"
        print(f"\n--- {label}", flush=True)
        started = time.monotonic()
        try:
            app.ensure_no_panel()
            case.fn()
        except Failure as exc:
            if case.advisory:
                results.add(case.id, case.title, "INFO", str(exc))
                print(f"    INFO ({time.monotonic() - started:.1f}s) {exc}", flush=True)
            else:
                results.add(case.id, case.title, "FAIL", str(exc))
                print(f"    FAIL ({time.monotonic() - started:.1f}s) {exc}", flush=True)
                try:
                    app.recover()
                except Failure as recovery:
                    print(f"    !! recovery failed: {recovery}", flush=True)
                    raise SystemExit(3) from recovery
        except Exception as exc:  # noqa: BLE001 - surface anything unexpected
            results.add(case.id, case.title, "FAIL", f"{type(exc).__name__}: {exc}")
            print(f"    ERROR {type(exc).__name__}: {exc}", flush=True)
            app.recover()
        else:
            results.add(case.id, case.title, "PASS")
            print(f"    PASS ({time.monotonic() - started:.1f}s)", flush=True)


def main() -> int:
    args = parse_args()
    if not args.no_build_check:
        code = preflight(args.app)
        if code:
            return code

    base = Path(tempfile.mkdtemp(prefix="sainte-e2e-")).resolve()
    # /var is a symlink to /private/var on macOS and the app refuses paths with
    # a symlink anywhere in them, so resolve() above is not cosmetic.
    work = base / "work"
    shots = base / "shots"
    home = base / "home"
    for directory in (work, shots, home):
        directory.mkdir(parents=True, exist_ok=True)

    print(f"app:      {args.app}")
    print(f"work dir: {base}")
    if args.keep or args.keep_shots:
        print("(artifacts will be kept)")

    fx = scenarios.Fixture(work)
    fx.reset()

    app = App(bundle=args.app, home=home, work=work, shots=shots)
    results = Results()

    groups = scenarios.build_groups(app, fx)
    if args.tier:
        groups = [g for g in groups if args.tier.lower() in g.name.lower()]
    if args.only:
        needle = args.only.upper()
        for group in groups:
            group.cases = [c for c in group.cases if needle in c.id]
        groups = [g for g in groups if g.cases]

    if not groups:
        print("no cases matched the filter", file=sys.stderr)
        shutil.rmtree(base, ignore_errors=True)
        return 2

    exit_code = 0
    index = 0
    try:
        for group in groups:
            fx.reset()
            run_group(app, group, results, base, index)
            index += 1
    except SystemExit as exc:
        exit_code = int(exc.code or 0)
    except KeyboardInterrupt:
        print("\ninterrupted", file=sys.stderr)
        exit_code = 130
    finally:
        try:
            app.quit()
        except Exception:
            pass

    print(f"\n{'=' * 72}\nsummary\n{'=' * 72}")
    for case_id, title, status, detail in results.entries:
        print(f"  {status}  {case_id}  {title}")
        if detail:
            for line in str(detail).splitlines():
                print(f"          {line}")
    total = len(results.entries)
    print(
        f"\n{results.passed_count}/{total} passed, {len(results.failed)} failed"
    )

    keep = args.keep or args.keep_shots or bool(results.failed)
    if keep:
        print(f"artifacts kept: {base}")
    else:
        shutil.rmtree(base, ignore_errors=True)
        print("work dir removed (use --keep to inspect it)")

    return 1 if results.failed or exit_code else 0


if __name__ == "__main__":
    sys.exit(main())
