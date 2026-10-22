// Fetch exact upstream source material for the Electron 44.4.1 source review.
// Does not approve a review or change the source manifest. Each archive remains
// the upstream tar stream; assembly destinations are recorded separately.
import {mkdir,readFile,writeFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const directory=path.join(root,'.local/release-source-completion/electron');
await mkdir(directory,{recursive:true});
const version='152.0.7977.78';
const selected=[
 'third_party/blink/renderer','third_party/blink/common','third_party/blink/public','third_party/blink/tools',
 'third_party/axe-core','third_party/eigen3','third_party/hunspell','third_party/hyphenation-patterns',
 'third_party/isimpledom','base/third_party/nspr',
 'net/third_party/mozilla_security_manager','net/third_party/mozilla_win','url',
 'build','build_overrides','tools/clang','tools/rust','tools/grit','third_party/grpc',
];
for(const name of ['symphonia','symphonia_bundle_flac','symphonia_bundle_mp3','symphonia_codec_pcm','symphonia_codec_vorbis','symphonia_common','symphonia_core','symphonia_metadata']){
 selected.push(`third_party/rust/${name}`);
 selected.push(`third_party/rust/chromium_crates_io/vendor/${name.replaceAll('_','-')}-v0_6`);
}
const targets=selected.map(p=>({name:`chromium-${p.replaceAll('/','-')}`,version,file:`chromium-${version}-${p.replaceAll('/','-')}.tar.gz`,url:`https://chromium.googlesource.com/chromium/src/+archive/${version}/${p}.tar.gz`,kind:'electron-component-source',destination:`src/${p}`}));
targets.push({name:'node',version:'24.21.0',file:'node-v24.21.0.tar.xz',url:'https://nodejs.org/dist/v24.21.0/node-v24.21.0.tar.xz',kind:'electron-component-source',destination:'src/third_party/electron_node'});
for(const [name,revision,url,destination] of [
 ['eigen','d53ac33805ba0a23fa139adaf24227fb6707e6fa','https://chromium.googlesource.com/external/gitlab.com/libeigen/eigen','src/third_party/eigen3/src'],
 ['dawn','ab8827bc57b176eeaa89f71324130c02d4d41145','https://dawn.googlesource.com/dawn','src/third_party/dawn'],
 ['directx-shader-compiler','1f8a14aecd4f2f25991fa9f7aad6c320fea91409','https://chromium.googlesource.com/external/github.com/microsoft/DirectXShaderCompiler','src/third_party/dawn/third_party/directx-shader-compiler/src'],
 ['liblouis','9700847afb92cb35969bdfcbbfbbb74b9c7b3376','https://chromium.googlesource.com/external/liblouis-github','src/third_party/liblouis/src'],
 ['hunspell-dictionaries','cccf64a8acc951afe3f47fee023908e55699bc58','https://chromium.googlesource.com/chromium/deps/hunspell_dictionaries','src/third_party/hunspell_dictionaries'],
 ['microsoft-dxheaders','62c23d5ec700659453c6fe89d296554b2a5e7edc','https://chromium.googlesource.com/external/github.com/microsoft/DirectX-Headers','src/third_party/microsoft_dxheaders/src'],
 ['microsoft-webauthn','ef82c157125a0490e05f6ea82a7adb1b8e1bad08','https://chromium.googlesource.com/external/github.com/microsoft/webauthn','src/third_party/microsoft_webauthn/src'],
])targets.push({name,version:revision,file:`${name}-${revision.slice(0,12)}.tar.gz`,url:`${url}/+archive/${revision}.tar.gz`,kind:'electron-component-source',destination});
targets.push({name:'axe-core-preferred-source',version:'281653df3794f429b71327fe3afa37ca0fadb1c7',file:'axe-core-281653df3794.tar.gz',url:'https://github.com/dequelabs/axe-core/archive/281653df3794f429b71327fe3afa37ca0fadb1c7.tar.gz',kind:'electron-component-source',destination:'upstream/axe-core'});
targets.push({name:'electron-nan',version:'675cefebca42410733da8a454c8d9391fcebfbc2',file:'nan-675cefebca42.tar.gz',url:'https://github.com/nodejs/nan/archive/675cefebca42410733da8a454c8d9391fcebfbc2.tar.gz',kind:'electron-component-source',destination:'src/third_party/nan'});
const filter=process.argv.slice(2);
const chosen=filter.length?targets.filter(t=>filter.some(f=>t.name.includes(f))):targets;
const results=[];let cursor=0;
await Promise.all(Array.from({length:4},async()=>{
 while(cursor<chosen.length){
  const target=chosen[cursor++],file=path.join(directory,target.file);
  try{
   let existing=false;try{existing=(await stat(file)).size>0;}catch{}
   if(!existing)await new Promise((resolve,reject)=>{
    const child=spawn('curl.exe',['--fail','--location','--retry','2','--connect-timeout','30','--max-time','600','--silent','--show-error','-o',file+'.part',target.url],{windowsHide:true,stdio:'inherit'});
    child.on('error',reject);child.on('exit',async code=>{if(code!==0)return reject(Error(`curl ${code}`));try{const {rename}=await import('node:fs/promises');await rename(file+'.part',file);resolve();}catch(e){reject(e);}});
   });
   const bytes=await readFile(file),sha256=createHash('sha256').update(bytes).digest('hex');
   const result={...target,bytes:bytes.length,sha256};results.push(result);
   await writeFile(file+'.json',JSON.stringify(result,null,2)+'\n');
   console.log(`OK ${target.name}: ${bytes.length}`);
  }catch(error){results.push({...target,error:error.message});console.log(`FAIL ${target.name}: ${error.message}`);}
 }
}));
await writeFile(path.join(directory,'download-report.json'),JSON.stringify(results,null,2)+'\n');
console.log(JSON.stringify({succeeded:results.filter(r=>!r.error).length,failed:results.filter(r=>r.error).map(r=>r.name)},null,2));
