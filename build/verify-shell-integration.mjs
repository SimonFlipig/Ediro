import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getMakeNsisPath} from 'app-builder-lib/out/toolsets/windows.js';
import {prepareNsisTemplate} from '../scripts/prepare-nsis-template.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),run=promisify(execFile);
process.env.ELECTRON_BUILDER_CACHE??=path.join(root,'.local/electron-builder-cache');
const fixture=await mkdtemp(path.join(root,'.local/shell-integration-'));
const appId='io.github.simonflipig.ediro.shelltest.'+randomUUID();
const template=await prepareNsisTemplate(root);
const compiler=await getMakeNsisPath();
const nsis=`Unicode true
Name "Ediro Shell integration validation"
OutFile "${fixture}\\probe.exe"
SilentInstall silent
RequestExecutionLevel user
!define EDIRO_SHELL_TEST
!include "${root}build\\shell-integration.nsh"
Section
  SetOutPath "${fixture}"
  CreateShortCut "${fixture}\\probe.lnk" "$SYSDIR\\cmd.exe" "/c exit 0" "$SYSDIR\\cmd.exe" 0 SW_SHOWNORMAL "" "Ediro temporary Shell validation"
  StrCpy $0 "preserved-0"
  StrCpy $1 "preserved-1"
  StrCpy $2 "preserved-2"
  Push "preserved-stack"
  !insertmacro EdiroSetLnkAUMI "${fixture}\\probe.lnk" "${appId}"
  WriteINIStr "${fixture}\\results.ini" "Results" "SetAUMI" "$EdiroShellResult"
  WriteINIStr "${fixture}\\results.ini" "Results" "Register0" "$0"
  WriteINIStr "${fixture}\\results.ini" "Results" "Register1" "$1"
  WriteINIStr "${fixture}\\results.ini" "Results" "Register2" "$2"
  Pop $3
  WriteINIStr "${fixture}\\results.ini" "Results" "Stack" "$3"
  !insertmacro EdiroUninstShortcut "${fixture}\\probe.lnk"
  WriteINIStr "${fixture}\\results.ini" "Results" "Unpin" "$EdiroShellResult"
  !insertmacro EdiroUninstAppUserModelId "${appId}"
  WriteINIStr "${fixture}\\results.ini" "Results" "CustomList" "$EdiroCustomListResult"
  WriteINIStr "${fixture}\\results.ini" "Results" "RecentList" "$EdiroRecentListResult"
  !insertmacro EdiroSetLnkAUMI "${fixture}\\does-not-exist.lnk" "${appId}"
  WriteINIStr "${fixture}\\results.ini" "Results" "MissingLink" "$EdiroShellResult"
SectionEnd
`;
await writeFile(path.join(fixture,'probe.nsi'),nsis);
try{
  const compile=await run(compiler.path,['/WX','/INPUTCHARSET','UTF8',path.join(fixture,'probe.nsi')],{cwd:fixture,windowsHide:true,env:{...process.env,...compiler.env},maxBuffer:4*1024*1024});
  await writeFile(path.join(fixture,'compile.log'),compile.stdout+compile.stderr);
}catch(error){await writeFile(path.join(fixture,'compile.log'),String(error.stdout)+String(error.stderr));throw error;}
await run(path.join(fixture,'probe.exe'),['/S'],{cwd:fixture,windowsHide:true,timeout:60000});
const iniBytes=await readFile(path.join(fixture,'results.ini'));
const ini=iniBytes[0]===0xff&&iniBytes[1]===0xfe?iniBytes.toString('utf16le'):iniBytes.toString('utf8');
const results=Object.fromEntries([...ini.matchAll(/^([^=\r\n]+)=(.*)$/gm)].map(([,key,value])=>[key,value.trim()]));
assert.equal(results.SetAUMI,'0');
assert.equal(results.CustomList,'0');assert.equal(results.RecentList,'0');
assert.ok(Number(results.Unpin)>=0,'Unpin interface must return a successful HRESULT');
assert.equal(results.Register0,'preserved-0');assert.equal(results.Register1,'preserved-1');assert.equal(results.Register2,'preserved-2');assert.equal(results.Stack,'preserved-stack');
assert.ok(Number(results.MissingLink)<0,'Missing shortcut must report a failed HRESULT');
const inspect=String.raw`
$taskFixture=$env:EDIRO_SHELL_TEST_DIRECTORY
$taskShell=New-Object -ComObject Shell.Application
$taskFolder=$taskShell.NameSpace($taskFixture)
$taskItem=$taskFolder.ParseName('probe.lnk')
$taskLink=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $taskFixture 'probe.lnk'))
[ordered]@{appId=$taskItem.ExtendedProperty('System.AppUserModel.ID');target=$taskLink.TargetPath;arguments=$taskLink.Arguments;description=$taskLink.Description;workingDirectory=$taskLink.WorkingDirectory;iconLocation=$taskLink.IconLocation} | ConvertTo-Json -Compress
`;
const shortcut=JSON.parse((await run('pwsh',['-NoProfile','-NonInteractive','-Command',inspect],{windowsHide:true,env:{...process.env,EDIRO_SHELL_TEST_DIRECTORY:fixture},maxBuffer:1024*1024})).stdout);
assert.equal(shortcut.appId,appId);assert.equal(shortcut.arguments,'/c exit 0');assert.equal(shortcut.description,'Ediro temporary Shell validation');
assert.match(shortcut.target,/\\cmd\.exe$/i);
assert.equal(shortcut.workingDirectory,fixture);assert.match(shortcut.iconLocation,/\\cmd\.exe,0$/i);
const report={schemaVersion:1,checkedAt:new Date().toISOString(),fixture,template,appId,results,shortcut,scope:'A temporary shortcut and random AppUserModelID only. Invokes cleanup APIs on an unpinned shortcut and isolated ID; does not claim a populated Jump List or user-pinned item was removed. Existing Ediro installations and shortcuts are untouched.'};
await writeFile(path.join(fixture,'report.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
