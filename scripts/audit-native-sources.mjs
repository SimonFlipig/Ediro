import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,mkdir,cp} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {hashFile} from './source-set.mjs';

// Read existing source archives; exercise only a fresh, isolated package copy.
// The modified DLL is a test fixture and is never used by the normal app/build.
const root=fileURLToPath(new URL('../',import.meta.url));
const cache=path.resolve(process.argv[2]??path.join(root,'.local/native-source-review/sources'));
const sdkFile=path.resolve(process.argv[3]??path.join(root,'.local/native-source-review/vips-dev-x64-web-8.18.6-static.zip'));
const run=promisify(execFile);
const manifest=JSON.parse(await readFile(path.join(root,'third_party/sources.json'),'utf8'));
const versions=JSON.parse(await readFile(path.join(root,'third_party/sharp-windows-native-versions.json'),'utf8'));
const installedVersions=JSON.parse(await readFile(path.join(root,'node_modules/@img/sharp-win32-x64/versions.json'),'utf8'));
assert.deepEqual(installedVersions,versions);
const originalDll=path.join(root,'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll');
const originalHash=await hashFile(originalDll);
assert.equal(originalHash.sha256,manifest.nativeSdk.dllSha256);
const sdkHash=await hashFile(sdkFile);assert.equal(sdkHash.sha256,manifest.nativeSdk.sha256);
const sdkDllEntry='vips-dev-8.18/bin/libvips-42.dll';
const sdkDll=(await run('tar',['-xOf',sdkFile,sdkDllEntry],{windowsHide:true,encoding:'buffer',maxBuffer:128*1024*1024})).stdout;
assert.equal(createHash('sha256').update(sdkDll).digest('hex'),originalHash.sha256);
assert.equal(sdkDll.length,originalHash.bytes);
const mapped=[];
for(const [name,version] of Object.entries(versions)){
  const archive=manifest.archives.find(entry=>entry.name===name&&entry.version===version);
  assert.ok(archive,`Missing source for ${name} ${version}`);
  assert.ok(archive.recipes?.length,`Missing build recipe for ${name}`);
  const actual=await hashFile(path.join(cache,archive.file));
  assert.equal(actual.bytes,archive.bytes);assert.equal(actual.sha256,archive.sha256);
  mapped.push({name,version,archive:archive.file,sha256:actual.sha256,recipes:archive.recipes});
}
const licenseIndex=JSON.parse(await readFile(path.join(root,'third_party/license-index.json'),'utf8'));
let licenseFiles=0;
for(const item of mapped){
  const entry=licenseIndex.find(e=>e.archive===item.archive);
  assert.ok(entry?.files.length,`Missing license originals: ${item.name}`);
  for(const file of entry.files){
    assert.equal((await hashFile(path.join(root,'third_party',file.file))).sha256,file.sha256);
    licenseFiles++;
  }
}
const tarText=async(file,entry)=>(await run('tar',['-xOf',path.join(cache,file),entry],{windowsHide:true,maxBuffer:16*1024*1024})).stdout;
const cargoLock=await tarText('librsvg-2.62.91.tar.xz','librsvg-2.62.91/Cargo.lock');
const registryCrates=[];
for(const section of cargoLock.split('[[package]]').slice(1)){
  const value=key=>section.match(new RegExp(`^${key} = "([^"]+)"`,'m'))?.[1];
  if(!value('source')?.startsWith('registry+'))continue;
  const name=value('name'),version=value('version'),checksum=value('checksum');
  const file=`${name}-${version}.crate`;
  const archive=manifest.archives.find(entry=>entry.file===file);
  assert.ok(archive,`Missing locked librsvg crate: ${file}`);
  assert.equal(archive.sha256,checksum);
  const actual=await hashFile(path.join(cache,file));
  assert.equal(actual.sha256,checksum);assert.equal(actual.bytes,archive.bytes);
  registryCrates.push({file,sha256:checksum});
}
assert.equal(registryCrates.length,350);
const buildMaterials=[];
for(const name of ['sharp','sharp-libvips','build-win64-mxe','mxe']){
  const archive=manifest.archives.find(entry=>entry.name===name);assert.ok(archive);
  const actual=await hashFile(path.join(cache,archive.file));
  assert.equal(actual.sha256,archive.sha256);assert.equal(actual.bytes,archive.bytes);
  buildMaterials.push({name,file:archive.file,sha256:actual.sha256});
}
function imports(bytes){
  const pe=bytes.readUInt32LE(0x3c),sections=bytes.readUInt16LE(pe+6),optional=pe+24;
  assert.equal(bytes.readUInt16LE(optional),0x20b,'Expected PE32+');
  const table=optional+bytes.readUInt16LE(pe+20),importRva=bytes.readUInt32LE(optional+120);
  const offset=rva=>{
    for(let i=0;i<sections;i++){
      const section=table+i*40,start=bytes.readUInt32LE(section+12),size=Math.max(bytes.readUInt32LE(section+8),bytes.readUInt32LE(section+16));
      if(rva>=start&&rva<start+size)return bytes.readUInt32LE(section+20)+rva-start;
    }
    throw Error('PE RVA not in sections');
  };
  const names=[];
  for(let descriptor=offset(importRva);bytes.readUInt32LE(descriptor+12)!==0;descriptor+=20){
    const start=offset(bytes.readUInt32LE(descriptor+12));
    names.push(bytes.toString('ascii',start,bytes.indexOf(0,start)));
  }
  return names;
}
const nativeImports={};
for(const name of ['libvips-42.dll','libvips-cpp-8.18.6.dll','sharp-win32-x64-0.35.4.node']){
  nativeImports[name]=imports(await readFile(path.join(root,'node_modules/@img/sharp-win32-x64/lib',name)));
}
const fixture=await mkdtemp(path.join(root,'.local/native-relink-'));
for(const name of ['sharp','@img/sharp-win32-x64']){
  const destination=path.join(fixture,'node_modules',name);
  await mkdir(path.dirname(destination),{recursive:true});
  await cp(path.join(root,'node_modules',name),destination,{recursive:true,errorOnExist:true,force:false});
}
const probe=String.raw`
const assert=require('node:assert/strict');
const {createHash}=require('node:crypto');
const sharp=require('sharp');
const addon=require('@img/sharp-win32-x64/sharp.node');
const hash=b=>createHash('sha256').update(b).digest('hex');
(async()=>{
 const input=Buffer.from('<svg width="32" height="24"><rect width="32" height="24" fill="#2468ac"/><circle cx="16" cy="12" r="7" fill="#edcb98"/></svg>');
 const base=await sharp(input).png().toBuffer();
 const outputs={};
 for(const format of ['png','jpeg','webp','tiff','gif','avif']){
  const out=await sharp(base).resize(16,12).toFormat(format).toBuffer();
  const meta=await sharp(out).metadata();assert.equal(meta.width,16);assert.equal(meta.height,12);
  outputs[format]={sha256:hash(out),width:meta.width,height:meta.height,bytes:out.length};
 }
 const palette=await sharp(base).png({palette:true,colours:8}).toBuffer();
 assert.equal((await sharp(palette).metadata()).isPalette,true);
 outputs.palette={sha256:hash(palette),bytes:palette.length};
 console.log(JSON.stringify({nativeVersion:addon.libvipsVersion().semver,addonPath:require.resolve('@img/sharp-win32-x64/sharp.node'),loadedLibraries:process.report.getReport().sharedObjects.filter(file=>/vips.*\.dll$/i.test(file)),outputs}));
})().catch(error=>{console.error(error);process.exitCode=1;});`;
const execute=async()=>JSON.parse((await run(process.execPath,['-e',probe],{cwd:fixture,windowsHide:true,maxBuffer:1024*1024})).stdout);
const versionProbe=String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NativeVersionProbe {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr LoadLibrary(string file);
 [DllImport("kernel32.dll",CharSet=CharSet.Ansi,SetLastError=true)] static extern IntPtr GetProcAddress(IntPtr module,string name);
 [UnmanagedFunctionPointer(CallingConvention.Cdecl)] delegate IntPtr VersionFunction();
 public static string Read(string file) {
   var module=LoadLibrary(file); if(module==IntPtr.Zero)throw new Exception("LoadLibrary failed: "+Marshal.GetLastWin32Error());
   var entry=GetProcAddress(module,"vips_version_string");if(entry==IntPtr.Zero)throw new Exception("Export not found");
   return Marshal.PtrToStringAnsi(Marshal.GetDelegateForFunctionPointer<VersionFunction>(entry)());
 }
}
'@
[NativeVersionProbe]::Read($env:NATIVE_AUDIT_DLL_PATH)
`;
const fixtureDll=path.join(fixture,'node_modules/@img/sharp-win32-x64/lib/libvips-42.dll');
const dllVersion=async()=>(await run('pwsh',['-NoProfile','-NonInteractive','-Command',versionProbe],{cwd:fixture,windowsHide:true,env:{...process.env,NATIVE_AUDIT_DLL_PATH:fixtureDll},maxBuffer:1024*1024})).stdout.trim();
const baseline=await execute();
assert.equal(baseline.nativeVersion,versions.vips);
assert.ok(baseline.addonPath.startsWith(fixture));
const originalVersionString=await dllVersion();assert.equal(originalVersionString,versions.vips);
const modified=await readFile(fixtureDll),from=Buffer.from(versions.vips+'\0'),to=Buffer.from('8.18.7\0');
assert.equal(from.length,to.length);
const offsets=[];
for(let offset=modified.indexOf(from);offset!==-1;offset=modified.indexOf(from,offset+from.length))offsets.push(offset);
assert.ok(offsets.length>0&&offsets.length<20,'Unexpected version marker layout');
for(const offset of offsets)to.copy(modified,offset);
await writeFile(fixtureDll,modified);
const replacement=await execute();
// Numeric ABI version stays unchanged; the exported string identifies the modified DLL.
const modifiedVersionString=await dllVersion();assert.equal(modifiedVersionString,'8.18.7');
assert.equal(replacement.nativeVersion,versions.vips);
assert.ok(replacement.loadedLibraries.some(file=>file.replace(/^\\\\\?\\/,'')===fixtureDll));
assert.deepEqual(replacement.outputs,baseline.outputs);
assert.equal((await hashFile(originalDll)).sha256,originalHash.sha256);
const report={schemaVersion:1,checkedAt:new Date().toISOString(),platform:process.platform,arch:process.arch,node:process.version,installedNativeVersionMatch:true,originalDll:{sha256:originalHash.sha256,bytes:originalHash.bytes,matchesOfficialSdk:true},officialSdk:{url:manifest.nativeSdk.url,sha256:sdkHash.sha256,bytes:sdkHash.bytes,dllEntry:sdkDllEntry,dllBytes:sdkDll.length},mappedComponents:mapped,licenseFilesVerified:licenseFiles,buildMaterials,registryCratesVerified:registryCrates.length,registryCrates,nativeImports,replacement:{passed:true,method:'In an isolated package copy, changed same-length NUL-terminated libvips version strings from 8.18.6 to 8.18.7; verified the changed vips_version_string export and loaded DLL path in fresh sharp processes. Numeric ABI version and sharp.node stay unchanged.',changedOffsets:offsets,modifiedDllSha256:createHash('sha256').update(modified).digest('hex'),baselineVersionString:originalVersionString,replacementVersionString:modifiedVersionString,numericVersion:replacement.nativeVersion,formats:replacement.outputs,originalRuntimeUnchanged:true,completeSourceRebuildPerformed:false},scope:'Tests dynamic loading of an interface-compatible modified DLL and real raster operations. Does not claim a complete source rebuild or bit-reproducible compilation.'};
await writeFile(path.join(root,'third_party/build-evidence/native-runtime-audit.json'),JSON.stringify(report,null,2)+'\n');
await writeFile(path.join(fixture,'report.json'),JSON.stringify({...report,baseline,replacementProbe:replacement},null,2)+'\n');
console.log(JSON.stringify({fixture,components:mapped.length,licenseFilesVerified:licenseFiles,replacementPassed:true},null,2));
