"""Tests for the bundled defsys build scripts (resources/defsys/scripts).

Run from the repository root:  python -m unittest discover -s tests -p "test_*.py"
(The TypeScript tests in this folder are run by the host and are not touched by this file.)
"""
import contextlib
import io
import json
import re
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

REPO = Path(__file__).resolve().parent.parent
SCRIPTS = REPO / "resources" / "defsys" / "scripts"
SAMPLE = REPO / "resources" / "defsys" / "examples" / "multi-brand-sample.yaml"
sys.path.insert(0, str(SCRIPTS))

import build  # noqa: E402
from export_dtcg import style_dictionary_config  # noqa: E402
from export_figma import export_build_scripts  # noqa: E402
from model import Collection, Variable  # noqa: E402

MARKER = "hygiene/marker"
NOTE = "// First 256 combinations only; trim or extend this array as needed.\n"
LINE_BREAKS = ("\n", "\r", "\r\n", chr(0x2028), chr(0x2029))


def _col(name, n_modes=1):
    modes = [f"m{i}" for i in range(n_modes)]
    return Collection(name, modes, [Variable(MARKER, "number", {m: 4 for m in modes})])


def _combos(config_js):
    return json.loads(re.search(r"const combos = (\[.*?\n\]);", config_js, re.S).group(1))


def _run_build(*argv):
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = build.main(list(argv))
    return code, out.getvalue(), err.getvalue()


class CommentSafeName(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.cfg, _, cls.collections, _, _ = build.generate(str(SAMPLE))

    def _script_for(self, name):
        files = export_build_scripts(self.collections + [_col(name)], self.cfg)
        (script,) = [body for body in files.values() if MARKER in body]
        return script

    def test_normal_name_is_unchanged(self):
        first = self._script_for("Density").split("\n", 1)[0]
        self.assertEqual(first, "// Design System Definer: Density collection. Run with use_figma.")

    def test_line_breaks_cannot_end_the_comment(self):
        for sep in LINE_BREAKS:
            with self.subTest(sep=repr(sep)):
                lines = self._script_for(f"Brand{sep}alert(1) x").split("\n")
                self.assertEqual(
                    lines[0], "// Design System Definer: Brand alert(1) x collection. Run with use_figma.")
                self.assertTrue(lines[1].startswith("const DATA = "))
                for terminator in ("\r", chr(0x2028), chr(0x2029)):
                    self.assertNotIn(terminator, lines[0])


class BoundedCombinations(unittest.TestCase):
    def test_huge_product_is_capped_quickly(self):
        cols = [_col(f"Dim{i}", 4) for i in range(12)]  # 4**12 = 16.7 million combinations
        start = time.monotonic()
        out = style_dictionary_config(cols)
        self.assertLess(time.monotonic() - start, 5)
        self.assertEqual(len(_combos(out)), 256)
        self.assertIn(NOTE, out)

    def test_exactly_cap_is_not_truncated(self):
        out = style_dictionary_config([_col(f"Dim{i}", 4) for i in range(4)])  # 4**4 = 256
        self.assertEqual(len(_combos(out)), 256)
        self.assertNotIn(NOTE, out)

    def test_one_over_cap_is_truncated(self):
        out = style_dictionary_config([_col("A", 257)])
        self.assertEqual(len(_combos(out)), 256)
        self.assertIn(NOTE, out)

    def test_small_product_is_complete(self):
        out = style_dictionary_config([_col("A", 3), _col("B", 2)])
        self.assertEqual(len(_combos(out)), 6)
        self.assertNotIn(NOTE, out)


class OutputBoundary(unittest.TestCase):
    def test_safe_destination_accepts_paths_inside(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            for rel in ("build-plan.md", "figma/Brand.Light.tokens.json", "a/b/c.txt", "figma/x/../y.json"):
                with self.subTest(rel=rel):
                    dest = build._safe_destination(out, rel)
                    self.assertIn(out.resolve(), dest.parents)

    def test_safe_destination_rejects_paths_outside(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            for rel in ("../escape.txt", "figma/../../escape.txt", "../../escape.txt", "a/../.."):
                with self.subTest(rel=rel):
                    with self.assertRaises(ValueError):
                        build._safe_destination(out, rel)

    def test_escaping_name_writes_nothing(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            hostile = {"ok.txt": "fine", "figma/../../escape.txt": "pwned"}
            with mock.patch.object(build, "render_files", return_value=hostile):
                code, _, err = _run_build(str(SAMPLE), "--approve", "--out", str(out))
            self.assertEqual(code, 2)
            self.assertIn("refusing to write outside the output folder", err)
            self.assertFalse((Path(tmp) / "escape.txt").exists())
            self.assertFalse(out.exists())  # all paths are checked before the first file is written

    def test_hostile_custom_dimension_name_cannot_escape(self):
        hostile = (
            "\ncustom_dimensions:\n"
            "  - name: \"../../evil\"\n"
            "    modes: [Summer, Winter]\n"
            "    tokens:\n"
            "      space/season-gap:\n"
            "        values: { Summer: space/16, Winter: space/24 }\n"
        )
        with tempfile.TemporaryDirectory() as tmp:
            project = Path(tmp) / "project"
            project.mkdir()
            config = project / "ds.config.yaml"
            config.write_text(SAMPLE.read_text(encoding="utf-8") + hostile, encoding="utf-8")
            out = project / "out"
            code, _, err = _run_build(str(config), "--approve", "--out", str(out))
            self.assertEqual(code, 2)
            self.assertIn("refusing to write outside the output folder", err)
            self.assertEqual([p.name for p in project.iterdir()], ["ds.config.yaml"])  # nothing escaped, nothing written

    def test_normal_build_still_writes_every_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "out"
            code, _, _ = _run_build(str(SAMPLE), "--approve", "--out", str(out))
            self.assertEqual(code, 0)
            expected = build.render_files(*build.generate(str(SAMPLE)))
            written = {p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file()}
            self.assertEqual(written, set(expected))


class NoAbbreviatedOptions(unittest.TestCase):
    def test_shortened_approve_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            for flag in ("--appr", "--app", "--approv"):
                with self.subTest(flag=flag):
                    err = io.StringIO()
                    with contextlib.redirect_stderr(err), contextlib.redirect_stdout(io.StringIO()):
                        with self.assertRaises(SystemExit) as caught:
                            build.main([str(SAMPLE), flag, "--out", str(Path(tmp) / "out")])
                    self.assertEqual(caught.exception.code, 2)
                    self.assertFalse((Path(tmp) / "out").exists())

    def test_full_options_still_work(self):
        code, _, _ = _run_build(str(SAMPLE))  # no --approve: prints the brief, writes nothing
        self.assertIn(code, (0, 1))


if __name__ == "__main__":
    unittest.main()
