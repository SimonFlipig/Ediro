# Installer source and license review

Baseline: `0.1.3-2026-10-22T08-59-44-637Z`. `installer-byte-verification.json`
identifies the exact setup hash, all seven DLLs actually embedded in it, and
their SHA256 matches against the publisher's original NSIS bundles.
The embedded uninstaller contains the same DLLs except nsis7z.dll.
The outer stub is NSIS-3 Unicode using Deflate compression.

Both NSIS vendor bundles were downloaded and matched the SHA256 values hard-coded
in electron-builder 26.15.3. All seven baseline plugins are byte-identical to these
downloads. UAC and nsis7z additionally match the original authors' distributions.
The bundle download origins are in `installer-binary-origin.json`; these binary
build tools are not presented as preferred source archives.

| Component | Material and license basis |
| --- | --- |
| NSIS bundle 3.0.4.1 | Corresponds to NSIS 3.04, official source mirror commit `25cf71ac318c73016d0706add96f25ef70ccd4f7` (v304). Full source includes Source/exehead, System/nsDialogs/nsExec plugins, SCons build files and compression sources. `installer-NSIS-COPYING` preserves the original zlib/libpng, bzip2 and CPL notices. The actual stub uses Deflate. The upstream build script records NSIS 3.04 and NSIS_MAX_STRLEN=8192. |
| StdUtils 1.1.4 | Official author tag 1.14 at `4e1117321001e54dcd2c52f72d3c359d5215e426`. Full C++ source, NSIS API support files and Visual Studio project are included. LGPL-2.1-or-later with the author's explicit clarification for verbatim DLLs used through the plugin API. `installer-StdUtils-*` retains the LGPL, clarification, copyright and embedded BLAKE2/RHash notices. |
| nsis7z 19.00 | Original Nsis7z_19.00.7z, including the plugin's C++ source and VS2017 solution. Its own instructions require C and CPP from lzma1900.7z; that exact official SDK is included. The plugin author's LGPL statement and the LZMA SDK public-domain statement are preserved separately in `installer-Nsis7z-*`. SDK source replaces the need to mistake the plugin-only archive for a complete build. |
| UAC 0.2.4c | Original UAC.zip contains C++ source, NSIS examples and original zlib/libpng permission notice. DLL matches byte-for-byte. |
| elevate.exe 1.0.0.2894 | Official author repository commit `d5cfc93d1ce06844a39d1a334a7a8081d26b6204`, including C source and Visual Studio projects. Resource script contains the same 1,0,0,2894 version and Johannes Passing / Copyright (C) 2007 metadata as the packaged executable. Original MIT LICENSE.md is retained without replacing its upstream placeholders. No bit-identical rebuild is claimed. |

NSIS resource preparation scripts are preserved as `installer-nsis-*-upstream.sh`
to document the vendor's component acquisition. They are historical evidence,
not scripts to execute automatically. Source reconstruction uses the source
archives listed in `js-installer-source-archives.json`; compiler/system SDKs
remain their normal externally supplied tools.

## Baseline WinShell gap and replacement boundary

The baseline installer also embeds WinShell 20121005. Its official download has
only ANSI/Unicode DLLs, and its page labels the license `Freeware` without an
explicit redistribution grant. This review does **not** treat that word as a
grant, infer an open-source license, or mark this component passed.
`installer-WinShell-declaration.html` preserves the official revision 25687.
`installer-plugin-license-guidance.html` preserves author Anders' general Wiki
license explanation; its exception for pages specifying another license does
not resolve the WinShell ambiguity.

The WinShell binary ZIP is excluded from the public source manifest. A separate
Windows COM implementation and its installation/upgrade/uninstallation checks
must replace this dependency and show that final setup/uninstaller payloads no
longer contain WinShell.dll before the installer review can pass. This baseline
report deliberately leaves that final verification to the replacement evidence.
