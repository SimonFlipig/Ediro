import hashlib
import importlib.util
import io
import lzma
import pathlib
import sys
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("source_filter", ROOT / "scripts/prepare-chromium-source.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class SourceFilterTest(unittest.TestCase):
    def fixture(self, directory, extra=()):
        payload = io.BytesIO()
        with tarfile.open(fileobj=payload, mode="w") as archive:
            for name, content in [("source/LICENSE", b"license unchanged"), ("source/src/main.cc", b"source code\n" * 1000),
                                  ("source/tools/bin/helper", b"\x7fELFbinary"), ("source/src/test.dll", b"\x7fELFcompiled"),
                                  ("source/toolchain/README", b"external toolchain"),
                                  ("source/models/bunny.obj", b"v 0.0 1.0 2.0\n"),
                                  ("source/data/source.c.gz.aar", b"compressed source fragment\x00\x01"), *extra]:
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))
        original = lzma.compress(payload.getvalue())
        path = directory / "input.tar.xz"
        path.write_bytes(original)
        policy = {"type": "test", "root": "source", "sourceBytes": len(original), "sourceSha256": hashlib.sha256(original).hexdigest(),
                  "sourceUrl": "https://example.org/source.tar.xz", "excludedTrees": ["toolchain"], "excludedPathPatterns": [],
                  "requiredAnchors": ["LICENSE", "src/main.cc", "data/source.c.gz.aar"]}
        return path, policy

    def test_preserves_source_and_reproduces_tar(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            original, policy = self.fixture(root)
            first, second = root / "first.tar", root / "second.tar"
            report = module.filter_archive(original, first, policy)
            module.filter_archive(original, second, policy)
            self.assertEqual(first.read_bytes(), second.read_bytes())
            self.assertEqual(report["membersExcluded"], 3)
            with tarfile.open(first) as archive:
                self.assertEqual(archive.getnames(), ["source/LICENSE", "source/src/main.cc", "source/models/bunny.obj", "source/data/source.c.gz.aar"])
                self.assertEqual(archive.extractfile("source/src/main.cc").read(), b"source code\n" * 1000)
            with self.assertRaises(FileExistsError):
                module.filter_archive(original, first, policy)

    def test_wrong_original_hash_does_not_create_output(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            original, policy = self.fixture(root)
            policy["sourceSha256"] = "0" * 64
            with self.assertRaisesRegex(ValueError, "checksum"):
                module.filter_archive(original, root / "output.tar", policy)
            self.assertFalse((root / "output.tar").exists())

    def test_source_anchor_cannot_be_silently_removed(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            original, policy = self.fixture(root)
            policy["excludedTrees"].append("src")
            with self.assertRaisesRegex(ValueError, "Required source missing"):
                module.filter_archive(original, root / "output.tar", policy)

    def test_unsafe_members_are_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = pathlib.Path(directory)
            original, policy = self.fixture(root, [("source/../outside", b"untrusted")])
            with self.assertRaisesRegex(ValueError, "Unsafe archive"):
                module.filter_archive(original, root / "output.tar", policy)


if __name__ == "__main__":
    unittest.main()
