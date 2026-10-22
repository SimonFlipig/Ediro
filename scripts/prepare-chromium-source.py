"""Produce a source archive from the pinned upstream Chromium source/tool bundle.

No archive is extracted onto disk and no included code is executed. Original file
contents and tar metadata are preserved; excluded entries are described by the
versioned policy. The uncompressed PAX tar avoids compressor-version differences.
"""
import hashlib
import io
import json
import lzma
import pathlib
import posixpath
import re
import sys
import tarfile
from collections import Counter

ROOT = pathlib.Path(__file__).resolve().parent.parent
POLICY = ROOT / "third_party/build-evidence/chromium-source-filter.json"


def digest_file(filename):
    digest = hashlib.sha256()
    size = 0
    with open(filename, "rb") as stream:
        while block := stream.read(8 * 1024 * 1024):
            digest.update(block)
            size += len(block)
    return {"bytes": size, "sha256": digest.hexdigest()}


class PrefixReader:
    def __init__(self, prefix, stream):
        self.prefix = io.BytesIO(prefix)
        self.stream = stream

    def read(self, size):
        prefix = self.prefix.read(size)
        return prefix + self.stream.read(size - len(prefix))


def filter_archive(source, destination, policy):
    actual = digest_file(source)
    if actual != {"bytes": policy["sourceBytes"], "sha256": policy["sourceSha256"]}:
        raise ValueError("Upstream Chromium archive checksum mismatch")
    patterns = [re.compile(value) for value in policy["excludedPathPatterns"]]
    anchors = {name: False for name in policy["requiredAnchors"]}
    counts, sizes = Counter(), Counter()
    kept = removed = original = 0
    prefix = policy["root"] + "/"
    root_name = policy["root"]

    def excluded(relative):
        for tree in policy["excludedTrees"]:
            if relative == tree or relative.startswith(tree + "/"):
                return "tree:" + tree
        for pattern in patterns:
            if pattern.search(relative):
                return "pattern:" + pattern.pattern
        return None

    # x mode preserves an existing archive on repeated or conflicting runs.
    with open(destination, "xb") as output, lzma.open(source, "rb") as decoded:
        with tarfile.open(fileobj=decoded, mode="r|") as archive, tarfile.open(fileobj=output, mode="w|", format=tarfile.PAX_FORMAT) as result:
            for entry in archive:
                original += 1
                name = entry.name.rstrip("/")
                if name != root_name and not name.startswith(prefix):
                    raise ValueError("Unexpected Chromium archive root")
                if name.startswith("/") or ".." in name.split("/"):
                    raise ValueError("Unsafe archive member")
                relative = name[len(prefix):] if name != root_name else ""
                reason = excluded(relative)
                stream = None
                if not reason and (entry.issym() or entry.islnk()):
                    target = entry.linkname if entry.islnk() else posixpath.join(posixpath.dirname(name), entry.linkname)
                    target = posixpath.normpath(target)
                    if not target.startswith(prefix):
                        reason = "link-outside-source-root"
                    elif excluded(target[len(prefix):]):
                        reason = "link-to-excluded-payload"
                if not reason and entry.isfile():
                    stream = archive.extractfile(entry)
                    start = stream.read(min(entry.size, 4096))
                    magic = start[:4]
                    if magic in (b"\x7fELF", b"\x00asm", b"\xfe\xed\xfa\xce", b"\xce\xfa\xed\xfe", b"\xfe\xed\xfa\xcf", b"\xcf\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xbe\xba\xfe\xca") or start.startswith(b"!<arch>\n"):
                        reason = "compiled-magic"
                    elif start.startswith(b"MZ") and len(start) >= 64:
                        pe = int.from_bytes(start[60:64], "little")
                        if pe + 4 <= len(start) and start[pe:pe + 4] == b"PE\x00\x00":
                            reason = "compiled-magic"
                    stream = PrefixReader(start, stream)
                elif not reason and not (entry.isdir() or entry.issym() or entry.islnk()):
                    reason = "non-source-special-file"
                if reason:
                    removed += 1
                    counts[reason] += 1
                    sizes[reason] += entry.size
                else:
                    result.addfile(entry, stream)
                    kept += 1
                    if relative in anchors:
                        anchors[relative] = True
                if original % 100000 == 0:
                    print(f"Filtered {original} members; kept {kept}, excluded {removed}", flush=True)
        # Read through the XZ trailer; a truncated stream cannot be accepted.
        while decoded.read(8 * 1024 * 1024):
            pass
    missing = [name for name, present in anchors.items() if not present]
    if missing:
        raise ValueError("Required source missing: " + ", ".join(missing))
    return {"schemaVersion": 1, "transform": policy["type"], "sourceUrl": policy["sourceUrl"], "original": actual,
            "derived": digest_file(destination), "membersRead": original, "membersKept": kept, "membersExcluded": removed,
            "exclusions": [{"rule": key, "members": counts[key], "bytes": sizes[key]} for key in sorted(counts)],
            "requiredAnchors": anchors, "fileContentsModified": False,
            "scope": "Source-tree filtering only; no compiler or toolchain rebuild performed."}


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("Usage: python scripts/prepare-chromium-source.py <original.tar.xz> <source-only.tar>")
    report = filter_archive(sys.argv[1], sys.argv[2], json.loads(POLICY.read_text(encoding="utf-8")))
    pathlib.Path(sys.argv[2] + ".filter-report.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
