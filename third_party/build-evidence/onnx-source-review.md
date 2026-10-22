# ONNX Runtime 1.30.0 material review

The actual packaged Windows x64 binaries and SHA256 values are listed in
`onnx-runtime-audit.json`. This is a source and notice review, not an upstream ONNX
rebuild or a claim that all bundled DLLs have the same license.

* ONNX Runtime: native version `1.30.0.20260909.4.f2c39fe`; full preferred-source
  archive is pinned to Microsoft commit `f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7`.
  MIT license and original ThirdPartyNotices are preserved as `onnx-Runtime-*`.
  The archive contains C/C++ runtime, JS native bindings, CMake dependency pins,
  `tools/ci_build/build.py`, package scripts and platform build definitions.
* DirectX Shader Compiler: dxcompiler.dll and dxil.dll report
  `1.8.2502.8 (b4711839e)`. The exact Microsoft source commit is
  `b4711839eb9a87da7c3436d9b212e0492359fbbd`. Its complete source archive, LLVM/NCSA
  license, third-party notices and DxilCompression license are included. The
  source contains its CMake build configuration and LLVM/Clang implementation.
* DirectML: DirectML.dll reports `1.15.4+241025-1615.1.dml-1.15.fac7597`.
  Upstream ONNX packages.config pins Microsoft.AI.DirectML 1.15.4;
  `onnx-build-packages.config` and `onnx-build-dml.cmake` preserve those inputs.
  The authoritative NuGet was downloaded from Microsoft's NuGet package endpoint
  for audit. The npm and NuGet DLLs differ in whole-file length/hash; all PE
  sections match exactly. The report records this limited comparison explicitly.

DirectML is a Microsoft redistributable, not an MIT/open-source component. Its
unchanged `onnx-DirectML-LICENSE.txt` governs the DLL. Section 1(a) permits copying
and distributing it in applications or services developed or built with machine
learning tools/frameworks for the identified Microsoft platforms; section 3(e)
restricts standalone distribution. Its unchanged third-party notices are in
`onnx-DirectML-ThirdPartyNotices.txt`. The SDK's separate LICENSE-CODE.txt covers
sample code and must not be misrepresented as the DLL's license.

The 202,292,617-byte DirectML NuGet and the onnxruntime-node binary npm tarball
are audit-only local downloads and are deliberately excluded from the public
source archive manifest. The complete ONNX source archive supplies the latter's
preferred source. This does not claim that DirectML's proprietary implementation
source is publicly available or that a full proprietary SDK/toolchain is part of
the source delivery. Actual application redistribution keeps the accompanying
Microsoft terms and third-party notices in resources/licenses/third_party.
