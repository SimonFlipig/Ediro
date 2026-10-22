// Usage: node --import tsx scripts/prepare-image-models.mjs --runtime .local/runtime --model depth|segment|all
import path from 'node:path';
import {prepareLocalImageModel,modelDirectory,localImageModels} from '../src/adapters/local-image-models.ts';

const args=process.argv.slice(2);
let runtime=path.resolve('.local/runtime'),selection='all';
for(let index=0;index<args.length;index++){
  const option=args[index],value=args[++index];
  if(option==='--runtime'&&value)runtime=path.resolve(value);
  else if(option==='--model'&&['depth','segment','all'].includes(value))selection=value;
  else throw new Error('用法：--runtime <运行时目录> --model depth|segment|all');
}
for(const kind of selection==='all'?['depth','segment']:[selection]){
  console.log(`准备 ${localImageModels[kind].title} → ${modelDirectory(runtime)}`);
  await prepareLocalImageModel(runtime,kind);
  console.log(`${localImageModels[kind].title} 资源校验通过。`);
}
