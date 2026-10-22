"""Stream an upstream tar.xz without extracting paths to Windows.

Windows bsdtar cannot decode some valid Unix names in Chromium's test data.
The JSONL index escapes such names and retains every member for audit.
"""
import json
import lzma
import os
import sys
import tarfile

archive, output = sys.argv[1:]
count = 0
empty = []
with lzma.open(archive, "rb") as decoded, open(output + ".part", "w", encoding="utf-8", newline="\n") as index:
    with tarfile.open(fileobj=decoded, mode="r|") as source:
        for member in source:
            count += 1
            if not member.name:
                empty.append({"index": count, "offset": member.offset, "type": repr(member.type)})
            name = member.name + ("/" if member.isdir() and not member.name.endswith("/") else "")
            index.write(json.dumps({"name": name, "bytes": member.size, "type": member.type.decode("ascii", "backslashreplace")}, ensure_ascii=True) + "\n")
    # Drain to the XZ checksum/trailer even when TAR has ended before it.
    while decoded.read(1024 * 1024):
        pass
    index.write(json.dumps({"complete": True, "members": count, "emptyNames": empty}) + "\n")
os.replace(output + ".part", output)
print(json.dumps({"archive": archive, "index": output, "members": count, "emptyNames": empty}))
