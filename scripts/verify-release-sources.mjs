import {writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describeSourceSet,readJson,verifyReview,verifyLocalArtifact,selectPublication,verifyPublication,verifyCandidateArtifacts,nativePayload,verifyNativePayload,hashFile,canonicalJson,verifyApplicationSource} from './source-set.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const args=process.argv.slice(2),publish=args.includes('--publish');
if(args.filter(a=>!a.startsWith('--')).length>1||args.some(a=>a.startsWith('--')&&a!=='--publish'))throw Error('Usage: node scripts/verify-release-sources.mjs [candidate-directory] [--publish]');
const candidateDirectory=args.find(a=>!a.startsWith('--'))??(await readJson(path.join(root,'.local/last-release-candidate.json'))).directory;
const directory=path.resolve(candidateDirectory),candidate=await readJson(path.join(directory,'candidate.json'));
if(!/^\d+\.\d+\.\d+$/.test(candidate.version))throw Error('Invalid release version');
const set=await describeSourceSet(root);
if(candidate.sourceSetId!==set.sourceSetId)throw Error('候选包缺少源码集绑定，或已过期；请重新构建候选包。');
verifyReview(await readJson(path.join(root,'config/source-review.json')),set);
const artifact=await verifyLocalArtifact(path.join(root,'.local/source-sets',set.sourceSetId),set);
const publication=selectPublication(await readJson(path.join(root,'config/source-publications.json')),set,artifact);
await verifyPublication(publication);
await verifyCandidateArtifacts(directory,candidate);
verifyNativePayload(await nativePayload(path.join(directory,'win-unpacked')),set);
const sourceReference=await readJson(path.join(directory,'source-reference.json'));
if(sourceReference.applicationVersion!==candidate.version||sourceReference.sourceSetId!==set.sourceSetId||canonicalJson(sourceReference.thirdParty)!==canonicalJson(publication))throw Error('候选包内的源码引用与公开附件不一致；请重新打包。');
const packedReference=await readJson(path.join(directory,'win-unpacked/resources/licenses/source-reference.json'));
if(canonicalJson(sourceReference)!==canonicalJson(packedReference))throw Error('包内源码指引不一致。');
const sourceName=`Ediro-${candidate.version}-source.zip`;
if(sourceReference.applicationSourceUrl!==`https://github.com/SimonFlipig/Ediro/releases/download/v${candidate.version}/${sourceName}`)throw Error('Application source URL does not match this release');
await verifyApplicationSource(path.join(directory,sourceName),candidate.applicationSources);
const sourceHash=await hashFile(path.join(directory,sourceName));
const referenceName='source-reference.json',referenceHash=await hashFile(path.join(directory,referenceName));
const all=[...candidate.artifacts,{name:sourceName,size:sourceHash.bytes,sha256:sourceHash.sha256},{name:referenceName,size:referenceHash.bytes,sha256:referenceHash.sha256}];
await writeFile(path.join(directory,'SHA256SUMS.txt'),all.map(a=>`${a.sha256}  ${a.name}`).join('\n')+'\n');
const volumes=publication.parts?`\n\n该源码集分为 ${publication.parts.length} 卷。请从上述固定页面下载全部分卷到同一目录，用 7-Zip 打开 \`${publication.parts[0].name}\`；逐卷校验值见 source-reference.json。下列 SHA256 对应全部分卷按编号拼接后的完整 ZIP。`:'';
const directions=`## 对应源码\n\n本版本应用源码：[${sourceName}](${sourceReference.applicationSourceUrl})。\n\n第三方依赖集：\`${set.sourceSetId}\`。多个应用版本可使用同一集合。\n\n[下载完整第三方源码及构建材料](${publication.url})（${publication.bytes} 字节）。${volumes}\n\nSHA256：\`${publication.sha256}\`。精确映射见本 Release 的 source-reference.json。源码与程序均可免费取得；历史源码附件保留。\n`;
await writeFile(path.join(directory,'SOURCE_LINKS.md'),directions);
if(!publish){console.log(`源码引用验证通过。将 SOURCE_LINKS.md 加入发布正文，上传 source-reference.json、应用源码和新版校验文件后，使用 --publish 完成最终检查及发布。\n${directory}`);}
else{
  const run=promisify(execFile),gh=process.env.EDIRO_GH_PATH??'gh';
  const call=async args=>(await run(gh,args,{cwd:root,windowsHide:true,maxBuffer:4*1024*1024})).stdout;
  const tag=`v${candidate.version}`,release=JSON.parse(await call(['release','view',tag,'--repo','SimonFlipig/Ediro','--json','isDraft,tagName,body,assets']));
  if(!release.isDraft||release.tagName!==tag)throw Error('Only an existing draft for the exact application tag can be published');
  if(!release.body.includes(publication.url)||!release.body.includes(set.sourceSetId)||!release.body.includes(publication.sha256)||!release.body.includes(sourceReference.applicationSourceUrl))throw Error('发布正文缺少清晰的应用／第三方源码链接及校验信息。');
  const sums=await hashFile(path.join(directory,'SHA256SUMS.txt'));
  const expected=[...all,{name:'SHA256SUMS.txt',size:sums.bytes,sha256:sums.sha256}];
  if(release.assets.length!==expected.length)throw Error('Unexpected draft assets; review before publication');
  for(const local of expected){const remote=release.assets.find(a=>a.name===local.name);if(remote?.state!=='uploaded'||remote.size!==local.size||remote.digest!==`sha256:${local.sha256}`)throw Error(`Remote release asset mismatch: ${local.name}`);}
  console.log(await call(['release','edit',tag,'--repo','SimonFlipig/Ediro','--draft=false','--latest']));
}
