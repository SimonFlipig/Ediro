// Build a reviewable mapping from the *actual* shipped Electron credits.
// Classification below is specific to Electron 44.4.1, Windows x64.
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const full='chromium-152.0.7977.78-source-only.tar';
const source='third_party/build-evidence/electron-upstream/';
const sha=content=>createHash('sha256').update(content).digest('hex');
const text=await readFile(path.join(root,'node_modules/electron/dist/LICENSES.chromium.html'),'utf8');
const maps={
 'AXE-CORE Accessibility Audit':{paths:['third_party/axe-core'],extra:['axe-core-281653df3794.tar.gz'],note:'MPL-2.0. The Chromium bundle and its build wrapper are retained; the exact upstream commit adds the preferred JavaScript source that is not present in axe.min.js.'},
 'Braille Translation Library':{paths:['third_party/liblouis'],extra:['liblouis-9700847afb92.tar.gz'],status:'extra-other-platform-source',note:'LGPL-2.1-or-later. ChromeOS ChromeVox target; Electron Windows does not ship ChromeVox. Exact source is additionally retained, without claiming this library is a Windows runtime constituent.',evidence:[source+'third_party__liblouis__BUILD.gn','chromium-152.0.7977.78-DEPS: checkout_linux condition for liblouis']},
 'DirectX-Shader-Compiler':{paths:['third_party/dawn/third_party/directx-shader-compiler'],extra:['directx-shader-compiler-1f8a14aecd4f.tar.gz','dawn-ab8827bc57b1.tar.gz'],note:'The upstream tree has mixed third-party notices, including Autoconf/other exceptions; preserve all of them. Actual dxcompiler.dll and dxil.dll are in the verified Windows runtime. Exact Dawn DEPS revision and DXC source, license texts, build files and patches are retained.'},
 'Eigen':{paths:['third_party/eigen3'],extra:['eigen-d53ac33805ba.tar.gz'],note:'MPL-2.0; retain Chromium build wrapper and exact header source.'},
 'ffmpeg':{paths:['third_party/ffmpeg'],extra:['ffmpeg-2b68d2babae73714846961fb0ee47e3b3d2e39a9.tar.gz'],note:'LGPL-2.1-or-later source and Chromium win/x64 configuration retained. Electron release.gn sets is_component_ffmpeg=true; its FFmpeg patch is in electron-44.4.1.tar.gz. CONFIG_GPL/NONFREE/VERSION3/GPLV3 are zero in the selected configuration; this is build-source evidence, not a new native rebuild.'},
 'grpc':{paths:['third_party/grpc'],note:'Retain mixed Apache/BSD/MPL notices, preferred source, generated files and vendoring patches in the exact Chromium subtree.'},
 'hunspell':{paths:['third_party/hunspell'],note:'MPL/GPL/LGPL multi-license text preserved. The vendored source, Chromium changes and build configuration are retained.'},
 'hunspell dictionaries':{paths:['third_party/hunspell_dictionaries'],extra:['hunspell-dictionaries-cccf64a8acc9.tar.gz'],note:'Mixed per-dictionary licenses; retain editable dictionaries, conversion/build material and all per-language notices. Do not apply a single permissive license to the collection.'},
 'hyphenation-patterns':{paths:['third_party/hyphenation-patterns'],note:'Mixed BSD/MIT/LGPL/MPL and other pattern-specific terms. Retain editable src patterns, generated hyb data, build-hyb.sh and the full license aggregation.'},
 'ISimpleDOM COM interfaces for accessibility':{paths:['third_party/isimpledom'],note:'MPL-1.1/GPL/LGPL alternatives. Preserve the actual IDL source, license and Chromium build rules.'},
 'Mozilla Personal Security Manager':{paths:['net/third_party/mozilla_security_manager'],note:'MPL-1.1 covered files including the Chromium fork modifications are retained at the exact revision.'},
 'Mozilla Windows Cert code':{paths:['net/third_party/mozilla_win'],note:'MPL-2.0; cert/win_util.cc and .h preserve the actual modified source and its notices.'},
 'Netscape Portable Runtime (NSPR)':{paths:['base/third_party/nspr'],note:'MPL-2.0; actual Chromium-vendored time parsing code and modifications are retained, rather than an unrelated stock NSPR release.'},
 'url_parse':{paths:['url'],note:'MPL-1.1/GPL/LGPL alternatives in legacy Mozilla-derived parsing files; retain the whole exact url subtree and all file-level notices.'},
 'WebKit':{paths:['third_party/blink'],note:'Contains LGPL-2.1-or-later and BSD code. Electron release.gn uses is_component_build=false, so Blink is part of the combined Electron executable. The full Chromium source (including external runtime trees), full Electron source plus patches, Node and NAN are retained for the source/relink route under LGPL-2.1 section 6(a). A Blink-only subset is not treated as sufficient.'},
 'icu':{paths:['third_party/icu'],note:'ICU permissive license plus third-party notices and Autoconf GPL exceptions. Preserve the complete source and exceptions; a GPL mention in an Autoconf notice does not change the license of the whole ICU runtime.'},
 'Node.js':{paths:[],extra:['node-v24.21.0.tar.xz'],note:'MIT core plus included third-party notices, including ICU/Autoconf exceptions. Official Node source tarball and checksum are retained; Electron Node patches and GN build integration are in the full Electron source.'},
 'JSZip':{paths:['third_party/catapult/third_party/jszip','third_party/catapult/tracing/third_party/jszip'],status:'source-covered-permissive-alternative',note:'Upstream offers MIT or GPL-3.0. Select MIT, preserve its copyright and license and the bundled distribution; the GPL alternative alone does not require treating the containing program as GPL. The exact Catapult copies are also retained in the full Chromium archive.'},
};
for(const name of ['symphonia','symphonia-bundle-flac','symphonia-bundle-mp3','symphonia-codec-pcm','symphonia-codec-vorbis','symphonia-common','symphonia-core','symphonia-metadata'])maps[name]={paths:[`third_party/rust/${name.replaceAll('-','_')}`,`third_party/rust/chromium_crates_io/vendor/${name}-v0_6`],note:'MPL-2.0, v0.6 vendored Rust preferred source. Both actual vendor source and Chromium GN wrapper are retained, with the Cargo manifest/lock and per-crate license.'};
const excluded={
 'Android NDK':{reason:'Android cross-compilation toolchain; Electron DEPS sets checkout_android=false and checkout_android_native_support=false for this Windows distribution.',evidence:['electron-upstream/electron__DEPS']},
 'Checker Qual':{reason:'Java checker annotation JAR used by the Android build. This Windows Electron package does not contain or execute Java/Android JARs; checkout_android=false.',evidence:['electron-upstream/electron__DEPS']},
 'glibc':{reason:'Linux C runtime/sysroot material. This Windows target does not distribute a glibc ELF runtime; Windows build configuration and PE binaries are the relevant target.'},
 'gtk':{reason:'Linux GTK integration; the Windows target uses Windows UI APIs, not GTK system libraries.',evidence:[source+'build__config__linux__BUILD.gn']},
 'libbrlapi':{reason:'BrlAPI Linux/ChromeOS accessibility integration; not distributed as part of Electron Windows.'},
 'libsecret':{reason:'Linux Secret Service integration; not the Windows credential-store implementation and not distributed with this Windows runtime.'},
 'libusbx':{reason:'services/device/usb/BUILD.gn selects libusb only for is_mac; is_win selects native WinUSB sources and winusb.lib. Full Chromium source also retains the libusb fork.',evidence:[source+'services__device__usb__BUILD.gn',source+'third_party__libusb__README.chromium']},
 'plasma-wayland-protocols':{reason:'KDE Wayland protocol definitions for Linux/Ozone; not a protocol backend selected by Electron Windows.'},
 'Speech Dispatcher':{reason:'Linux speech-dispatcher service integration; Electron Windows uses the Windows speech implementation and does not bundle this service.'},
 'v4l-utils':{reason:'Video4Linux capture backend; GN target is under media/capture/video/linux and is not selected for the Windows capture target.',evidence:[source+'media__capture__video__linux__BUILD.gn']},
 'ScreenAI Library':{reason:'The credited proprietary Chrome component is delivered by Chrome Component Updater. Its Chromium BUILD.gn target is testonly; the official Electron Windows runtime contains no ScreenAI library/models. This metadata entry is not a shipped Electron constituent and is not represented as archived source.',evidence:[source+'third_party__screen-ai__README.chromium',source+'third_party__screen-ai__BUILD.gn','electron-runtime-origin.json']},
};
const entries=[];let products=0,lgplMpl=0;
for(const block of text.split('<div class="product">').slice(1)){
 products++;
 const matchedLgplMpl=/GNU (?:LESSER|LIBRARY) GENERAL PUBLIC LICENSE|Mozilla Public License|MOZILLA PUBLIC LICENSE/i.test(block);
 const matchedOther=/GNU (?:AFFERO )?GENERAL PUBLIC LICENSE|Eclipse Public License|Common Development and Distribution|Common Public License|Open Software License/i.test(block);
 if(!matchedLgplMpl&&!matchedOther)continue;if(matchedLgplMpl)lgplMpl++;
 const name=block.match(/class="title">([^<]+)/)?.[1];
 const homepage=block.match(/class="homepage"><a href="([^"]+)/)?.[1];
 const base={name,homepage,creditsBlockSha256:sha(block),scanGroup:matchedLgplMpl?'LGPL-or-MPL-marker':'additional-copyleft-marker'};
 if(maps[name]){const m=maps[name];entries.push({...base,status:m.status||'source-covered',archiveFiles:[...(m.paths.length?[full]:[]),...(m.extra||[])],sourcePaths:m.paths,note:m.note,evidence:m.evidence||[]});}
 else if(homepage?.includes('/android/maven2/')&&homepage.endsWith('.aar'))entries.push({...base,status:'excluded-other-platform',reason:'Android Maven AAR package; Electron DEPS disables Android/native Android support, and this Windows runtime contains no AAR/DEX/Java payload. Credits aggregate other platform dependencies.',evidence:['electron-upstream/electron__DEPS','electron-runtime-origin.json']});
 else if(excluded[name])entries.push({...base,status:name==='ScreenAI Library'?'excluded-not-distributed':'excluded-other-platform',...excluded[name]});
 else throw Error(`Unreviewed copyleft marker: ${name}`);
}
assert.equal(products,780);assert.equal(lgplMpl,56);assert.equal(entries.length,62);
const report={schemaVersion:1,electronVersion:'44.4.1',target:'win32-x64',licenseFile:'node_modules/electron/dist/LICENSES.chromium.html',licenseFileSha256:sha(text),totalCreditEntries:products,lgplMplMarkerEntries:lgplMpl,additionalMarkerEntries:entries.length-lgplMpl,interpretation:'Credits are a cross-platform notice inventory, not a Windows binary SBOM. Source coverage is conservative; inclusion does not claim that a component is linked. Every scan match has either source material or a specific exclusion/alternative-license rationale.',entries,unresolvedEntries:[]};
await writeFile(path.join(root,'third_party/build-evidence/electron-license-coverage.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({products,lgplMpl,reviewed:entries.length,statusCounts:entries.reduce((r,e)=>(r[e.status]=(r[e.status]||0)+1,r),{}),unresolved:0},null,2));
