import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { defaultPromptConfig,promptConfigSchema,normalizePromptConfig,type PromptConfig } from '../src/core/prompt-config.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { compileRecipe,adaptChain } from '../src/core/compiler.js';
import { defaultParameters,moduleSchema,type Recipe } from '../src/core/domain.js';
import { seedModels } from '../src/core/models.js';
import { loadPromptConfig } from '../src/adapters/prompt-config-repository.js';
import { releasePromptConfig } from '../src/core/release-prompt-config.js';

test('自由语义名与模块编号共用编译规则，保留模块身份及重复图片',()=>{
  const config=structuredClone(defaultPromptConfig);
  config.module_header='## {module_number}. {module}';
  config.modules.subject={model_name:'主体与外观 / Main Subject',native_instruction:'',numbered_instruction:''};
  config.modules.viewpoint={model_name:'Camera Angle',native_instruction:'',numbered_instruction:''};
  const registry=new ModuleRegistry(undefined,config),a=registry.create('subject'),b=registry.create('subject'),angle=registry.create('viewpoint'),off=registry.create('style'),prompt=registry.create('prompt');
  a.asset_ids=['asset_same','asset_same'];a.user_instruction='原样保留 subject 和 image_9';
  b.user_instruction='纯文字模块';angle.asset_ids=['asset_same'];off.enabled=false;off.user_instruction='跳过';
  const recipe:Recipe={recipe_id:'recipe_names',schema_version:1,modules:[off,registry.create('style'),a,b,angle,prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const chain=compileRecipe(recipe,registry),flat=adaptChain(chain,seedModels()[1]);
  assert.deepEqual(chain.blocks.filter(b=>b.type==='text'&&b.text_role==='header').map(b=>b.text),['## 1. 主体与外观 / Main Subject','## 2. 主体与外观 / Main Subject','## 3. Camera Angle']);
  assert.deepEqual(flat.image_asset_ids,['asset_same','asset_same','asset_same']);
  assert.match(flat.prompt!,/原样保留 subject 和 image_9/);
  assert.equal(a.reference_type,'subject');assert.equal(a.title,'主体');
  assert.doesNotThrow(()=>moduleSchema.parse(a));
  assert.deepEqual(adaptChain(chain,seedModels()[0]).blocks,chain.blocks);
  recipe.modules=[angle,a,prompt];
  assert.match(adaptChain(compileRecipe(recipe,registry),seedModels()[1]).prompt!,/^## 1. Camera Angle/);
  config.modules.viewpoint.header=false;
  const hidden=adaptChain(compileRecipe(recipe,new ModuleRegistry(undefined,config)),seedModels()[1]).prompt!;
  assert.ok(!hidden.includes('Camera Angle'));assert.match(hidden,/## 2. 主体与外观/);
  config.module_header='';
  assert.ok(!adaptChain(compileRecipe(recipe,new ModuleRegistry(undefined,config)),seedModels()[1]).prompt!.includes('主体与外观'));
});

test('模型语义名允许中文空格标点，拒绝空白、换行及过长名称；新标题格式可导出重载',()=>{
  for(const name of ['主体','Camera Angle','主体：外观','Literal {images}']){
    const config={...defaultPromptConfig,module_header:'[{module_number}. {module}]',modules:{subject:{model_name:name}}};
    assert.equal(normalizePromptConfig(JSON.parse(JSON.stringify(config))).modules.subject.model_name,name);
  }
  for(const name of ['', '   ', 'a\nb', 'a\rb', 'a\tb', 'a'.repeat(81)]){
    assert.throws(()=>promptConfigSchema.parse({...defaultPromptConfig,modules:{subject:{model_name:name}}}));
    assert.throws(()=>moduleSchema.parse({...new ModuleRegistry().create('subject'),model_name:name}));
  }
  assert.throws(()=>promptConfigSchema.parse({...defaultPromptConfig,module_header:'{unknown}'}));
  assert.equal(defaultPromptConfig.module_header,'{module}:');
});

test('调优规则独立于显示名称，快照冻结规则，手写引用不改写',()=>{
  const config=structuredClone(defaultPromptConfig);
  config.revision='private-test';config.modules.subject={model_name:'subject',native_instruction:'Keep {images}.',numbered_instruction:'Preserve {images}.'};
  const registry=new ModuleRegistry(undefined,config),subject=registry.create('subject'),neutral=registry.create('image_text');
  subject.title='我的产品';subject.asset_ids=['asset_a','asset_a'];subject.user_instruction='Match subject to image_9.';neutral.asset_ids=['asset_b'];
  const recipe:Recipe={recipe_id:'recipe_test',schema_version:1,modules:[subject,neutral,registry.create('prompt')],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const chain=compileRecipe(recipe,registry),flat=adaptChain(chain,seedModels()[1]);
  assert.match(flat.prompt!,/^subject:\nPreserve image_1, image_2\./);
  assert.match(flat.prompt!,/Match subject to image_9\./);assert.ok(!flat.prompt!.includes(subject.title));
  assert.deepEqual(chain.blocks.filter(b=>b.type==='image').map(b=>b.image_name),['image_1','image_2','image_3']);
  assert.deepEqual(flat.image_asset_ids,['asset_a','asset_a','asset_b']);
  registry.promptConfig.revision='changed';assert.equal(chain.prompt_config?.revision,'private-test');
  subject.enabled=false;const reordered=compileRecipe(recipe,registry);
  assert.deepEqual(reordered.blocks.filter(b=>b.type==='image').map(b=>b.image_name),['image_1']);
  assert.equal(adaptChain(reordered,seedModels()[1]).prompt,'image_1');
});

test('模块内单换行、同类模块间双换行；保留用户换行并跳过空模块和停用模块',()=>{
  const config=structuredClone(defaultPromptConfig);
  config.image_label='';config.module_header='{module}: {images}';
  config.modules.subject={native_instruction:'Keep {images}.',numbered_instruction:'Keep {images}.'};
  const registry=new ModuleRegistry(undefined,config),first=registry.create('subject'),second=registry.create('subject'),off=registry.create('style');
  first.asset_ids=['asset_a','asset_b'];first.user_instruction='line one\n\nline two\n';
  second.asset_ids=['asset_c'];second.user_instruction='second note';off.enabled=false;off.user_instruction='not sent';
  const recipe:Recipe={recipe_id:'recipe_spacing',schema_version:1,modules:[first,off,registry.create('style'),second,registry.create('prompt')],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const chain=compileRecipe(recipe,registry);
  assert.equal(adaptChain(chain,seedModels()[1]).prompt,'subject: image_1, image_2\nKeep image_1, image_2.\nline one\n\nline two\n\n\nsubject: image_3\nKeep image_3.\nsecond note');
  assert.deepEqual(adaptChain(chain,seedModels()[0]).blocks,chain.blocks);
  assert.equal(chain.blocks.find(b=>b.type==='text'&&b.text_role==='user')?.type,'text');
  assert.ok(chain.blocks.some(b=>b.type==='text'&&b.text===first.user_instruction));
  config.intra_module_separator=' | ';config.inter_module_separator=' <NEXT> ';
  assert.equal(adaptChain(compileRecipe(recipe,new ModuleRegistry(undefined,config)),seedModels()[1]).prompt,'subject: image_1, image_2 | Keep image_1, image_2. | line one\n\nline two\n <NEXT> subject: image_3 | Keep image_3. | second note');
  config.intra_module_separator='';config.inter_module_separator='';
  assert.equal(adaptChain(compileRecipe(recipe,new ModuleRegistry(undefined,config)),seedModels()[1]).prompt,'subject: image_1, image_2Keep image_1, image_2.line one\n\nline two\nsubject: image_3Keep image_3.second note');
});

test('旧配置只在当前使用时升级，历史链保留旧连接符',async()=>{
  const {version,intra_module_separator,inter_module_separator,...rest}=defaultPromptConfig;
  const legacy:PromptConfig={...rest,version:1,text_separator:'\n\n'};
  assert.equal(normalizePromptConfig(legacy).intra_module_separator,'\n');
  assert.equal(normalizePromptConfig({...legacy,text_separator:' / '}).intra_module_separator,' / ');
  assert.equal(normalizePromptConfig({...legacy,text_separator:' / '}).inter_module_separator,' / ');
  assert.equal(promptConfigSchema.parse(legacy).version,1);
  const registry=new ModuleRegistry(),m=registry.create('image_text'),p=registry.create('prompt');m.asset_ids=['asset_a'];m.user_instruction='note';p.user_instruction='next';
  const recipe:Recipe={recipe_id:'recipe_legacy',schema_version:1,modules:[m,p],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
  const chain=compileRecipe(recipe);chain.prompt_config=structuredClone(legacy);
  const frozen=JSON.stringify(chain);
  assert.equal(adaptChain(chain,seedModels()[1]).prompt,'image_1\n\nnote\n\nnext');
  assert.equal(JSON.stringify(chain),frozen);
  assert.equal(adaptChain(compileRecipe(recipe,new ModuleRegistry(undefined,legacy)),seedModels()[1]).prompt,'image_1\nnote\n\nnext');
  const dir=await mkdtemp(path.join(tmpdir(),'ediro-legacy-spacing-'));
  try{const file=path.join(dir,'prompt-config.v1.json'),raw=JSON.stringify(legacy);await writeFile(file,raw);assert.equal((await loadPromptConfig(dir)).version,2);const {readFile}=await import('node:fs/promises');assert.equal(await readFile(file,'utf8'),raw);}finally{await rm(dir,{recursive:true,force:true});}
});

test('配置允许直接指令但拒绝错误占位符；缺失用默认，损坏不能静默回退',async()=>{
  assert.doesNotThrow(()=>promptConfigSchema.parse({...defaultPromptConfig,modules:{subject:{numbered_instruction:'Keep structure.'}}}));
  assert.throws(()=>promptConfigSchema.parse({...defaultPromptConfig,module_header:'{subject}:'}));
  const dir=await mkdtemp(path.join(tmpdir(),'ediro-prompt-'));
  try{
    assert.deepEqual(await loadPromptConfig(dir),releasePromptConfig);
    await writeFile(path.join(dir,'prompt-config.v1.json'),JSON.stringify({...defaultPromptConfig,revision:'custom'}));
    assert.equal((await loadPromptConfig(dir)).revision,'custom');
    await writeFile(path.join(dir,'prompt-config.v1.json'),'{');
    await assert.rejects(loadPromptConfig(dir),/不会静默/);
  }finally{await rm(dir,{recursive:true,force:true});}
});

test('首次安装使用发布提示词，两种输入模式均展开模块及视角，本地覆盖不改写发布配置',async()=>{
  const dir=await mkdtemp(path.join(tmpdir(),'ediro-release-prompts-'));
  try{
    const config=await loadPromptConfig(dir),registry=new ModuleRegistry(undefined,config);
    const subject=registry.create('subject'),angle=registry.create('viewpoint'),prompt=registry.create('prompt');
    subject.asset_ids=['asset_subject'];angle.asset_ids=['asset_angle'];
    const recipe:Recipe={recipe_id:'recipe_release',schema_version:1,modules:[subject,angle,prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters}};
    const chain=compileRecipe(recipe,registry),flat=adaptChain(chain,seedModels()[1]);
    const native=adaptChain(chain,seedModels()[0]).blocks!.filter(b=>b.type==='text').map(b=>b.text).join('');
    for(const text of [native,flat.prompt!]){
      assert.match(text,/## 1\. subject\n/);
      assert.match(text,/Preserve the subject's structure, colors, and proportions as shown in image_1/);
      assert.match(text,/## 2\./);
      assert.match(text,/Adjust the camera viewpoint to "/);
      assert.doesNotMatch(text,/\{(?:viewpoint|images|module_number|module)\}/);
    }
    assert.deepEqual(flat.image_asset_ids,['asset_subject','asset_angle']);
    assert.deepEqual(chain.prompt_config,config);
    config.modules.subject.native_instruction='Local-only instruction';
    assert.notEqual((await loadPromptConfig(dir)).modules.subject.native_instruction,config.modules.subject.native_instruction);
    await writeFile(path.join(dir,'prompt-config.v1.json'),JSON.stringify(config));
    assert.deepEqual(await loadPromptConfig(dir),config);
    assert.notEqual(releasePromptConfig.modules.subject.native_instruction,config.modules.subject.native_instruction);
  }finally{await rm(dir,{recursive:true,force:true});}
});
