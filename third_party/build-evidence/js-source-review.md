# Packaged JavaScript source and notice review

Reviewed against candidate `0.1.3-2026-10-22T08-59-44-637Z` on 2026-10-22.
This records source/material inspection, not a claim that every upstream project was rebuilt.

## Actual distribution and byte checks

`js-packaged-inventory.json` enumerates the 41 npm package installations actually in
`resources/app.asar`, including both semver versions. Optional packages merely present
in package-lock.json are not counted as shipped. `js-byte-verification.json` verifies
every packaged file against the exact npm distribution archive, except package.json:
electron-builder intentionally removes development metadata from package.json.
All comparisons passed. Downloaded npm archive integrity also matched package-lock.json
or the exact npm registry integrity where a hoisted dependency needed lookup.

The downloadable originals are listed with URL, full SHA256 and size in
`js-installer-source-archives.json`. Source code for the native sharp/libvips package
is covered by the separate native-image review; its binary npm package is not added
as if it were preferred source.

## Preferred form and build inputs

| Shipped component | Preferred source and build materials |
| --- | --- |
| react 19.3.0, react-dom 19.3.0, scheduler 0.28.0 | React commit `1d34f91dfde6bba84d08b683aaba164c7194dacb`, matching all three npm gitHead values; includes Flow source, build scripts and dependency manifests. |
| electron-updater 6.8.9 | Official release tag resolved to `bed3a9c421a8a05c49f36a2af5d7ae3598cb1b95`; includes TypeScript, workspace configuration and build files. All 32 embedded source-map source texts match the archived source. |
| builder-util-runtime 9.7.0 | Source in electron-builder `512a57ec9bcda593d3e0970bd2b9a33a63beeb57`; package version is 9.7.0. All 14 embedded source-map source texts match the archived TypeScript. |
| global-agent 4.1.3 | Exact npm gitHead `e9138f654826f9a82e0ac4f3abdb9541ac988286`, with TypeScript and build configuration. |
| lazy-val 1.0.5 | Exact npm gitHead `b69ad4119f1b19bdab13c61ee2fcc88d46b89071`, with TypeScript, tsconfig and pnpm lock. License basis below. |
| tiny-typed-emitter 2.1.0 | Exact npm gitHead `66c1b66bc159675352a6f38911e4c6cf2117f3e4`, original source and package build configuration. |
| @img/colour 1.1.0 | Exact npm gitHead `179fa91fbdb8786b661f6bfb2b6de2885d4860f8`, committed bundle, original wrapper, declaration generator input and esbuild command. The bundle includes color 5.0.3, color-convert 3.1.3, color-name 2.1.0 and color-string 2.1.4. Their four exact npm source archives and original MIT notices are added separately. |
| onnxruntime-common / onnxruntime-node 1.30.0 | Full upstream ONNX release source at `f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7`, including JavaScript/TypeScript bindings, native binding source, CMake and build scripts. See onnx-source-review.md for separately licensed native DLLs. |
| sharp 0.35.4 and zod 4.6.5 | Original npm archives already include native/TypeScript preferred source. The separate sharp source archive and native build review cover its image dependencies. |
| Remaining packages | Original npm archives contain authored, readable JavaScript or authored TypeScript declarations; their license/notice files remain intact. |

`js-source-map-verification.json` records the 46 successful TypeScript correspondence
checks for the two electron-builder runtime packages. The source archive includes
upstream dependency manifests and build scripts; this review does not assert an
offline rebuild of every permissively licensed JavaScript compiler toolchain.

## lazy-val license evidence

The exact upstream package.json and npm metadata both declare `"license": "MIT"`
and author `Vladimir Krivosheev`. The locked upstream repository and npm archive do
not contain a separate LICENSE file. `js-lazy-val-package.json` preserves the
original declaration; `js-lazy-val-main.ts` preserves the corresponding authored
source. These are the evidence for the author's MIT designation.

`js-lazy-val-MIT-reference.txt` is the standard MIT text from SPDX license-list-data
v3.27.0, not a recovered upstream license file. Its placeholders are intentionally
retained. No copyright year or grant was invented or attributed to the author.
The MIT identifier is interpreted using npm's documented SPDX license field:
https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#license .

The four bundled color dependency notices are in `js-colour-notices/`. These files,
the original npm licenses and this evidence are copied into the installed and
portable distributions by scripts/package-windows.mjs.
