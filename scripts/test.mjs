import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const files=(await readdir(new URL('../tests/',import.meta.url))).filter(name=>name.endsWith('.test.ts')).map(name=>`tests/${name}`);
const child=spawn(process.execPath,['--import','tsx','--test',...files],{stdio:'inherit'});
child.on('error',error=>{console.error(error.message);process.exitCode=1;});
child.on('exit',code=>{process.exitCode=code??1;});
