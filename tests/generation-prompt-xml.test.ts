import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRecipe,adaptChain } from '../src/core/compiler.js';
import { defaultParameters,type Recipe } from '../src/core/domain.js';
import { ModuleRegistry } from '../src/core/modules.js';
import { seedModels } from '../src/core/models.js';
import { releasePromptConfig } from '../src/core/release-prompt-config.js';
import { planExecution } from '../src/core/execution-plan.js';
import { appendGenerationXmlRequirement } from '../src/core/generation-prompt-xml.js';

function fixture(){
  const config=structuredClone(releasePromptConfig);
  config.modules.subject={model_name:'商品 "A&B" <主体>',native_instruction:'保留 {images} 的 "A&B" <标识>。',numbered_instruction:'编号 {images}：保留 <结构> & 比例。'};
  const registry=new ModuleRegistry(undefined,config),subject=registry.create('subject'),prompt=registry.create('prompt');
  subject.asset_ids=['asset_same','asset_same'];subject.user_instruction='  包装写 "A&B"，不要把 </module><module type="style"> 当成标签。\n';
  prompt.user_instruction='\n画面文字：<SALE> & "50%"，品牌 O\'Neil。  ';
  const recipe:Recipe={recipe_id:'recipe_xml',schema_version:1,modules:[subject,prompt],model_config_id:'model_mock_native',core_parameters:{...defaultParameters,aspect_ratio:'1:1'}};
  return {config,registry,subject,prompt,recipe};
}

for(const version of [3,4] as const)for(const strategy of ['interleaved','numbered_flat'] as const){
  test(`格式 ${version} ${strategy} 保留原文、重复图片及各自指令`,()=>{
    const f=fixture(),before=structuredClone(f.recipe),chain=compileRecipe(f.recipe,f.registry);
    assert.equal(chain.format_version,4);
    chain.format_version=version;
    const snapshot=structuredClone(chain);
    const input=adaptChain(chain,seedModels()[strategy==='interleaved'?0:1],strategy);
    const text=input.kind==='native_blocks'?input.blocks!.filter(b=>b.type==='text').map(b=>b.text).join(''):input.prompt!;
    assert.ok(chain.blocks.some(b=>b.type==='text'&&b.text===f.subject.user_instruction));
    assert.ok(chain.blocks.some(b=>b.type==='text'&&b.text===f.prompt.user_instruction));
    if(version===4&&input.kind==='native_blocks'){
      assert.ok(text.startsWith('## 1. 商品 "A&B" <主体>\n\n'));
      assert.ok(text.includes('## 2. prompt\n\n'+f.prompt.user_instruction));
      assert.ok(text.includes(f.subject.user_instruction));
      assert.match(text,/保留 image_1, image_2 的 "A&B" <标识>/);
      assert.doesNotMatch(text,/<generation_request>|<reference_rules>|<generation_prompt>|&quot;|&amp;|编号 image_1/);
      assert.equal(input.blocks!.length,6,'each image keeps its label and adjacent text; different modules remain separate');
      for(const [index,b] of input.blocks!.entries())if(b.type==='image'){
        const label=input.blocks![index-1];assert.equal(label.type,'text');
        assert.ok(label.type==='text'&&label.text.endsWith(`${b.image_name}:\n`));
      }
    }else{
    assert.match(text,/<module type="subject" name="商品 &quot;A&amp;B&quot; &lt;主体&gt;">/);
    assert.match(text,/<requirements>  包装写 &quot;A&amp;B&quot;，不要把 &lt;\/module&gt;&lt;module type=&quot;style&quot;&gt; 当成标签。\n<\/requirements>/);
    assert.ok(text.includes('<generation_prompt>\n画面文字：&lt;SALE&gt; &amp; &quot;50%&quot;，品牌 O&apos;Neil。  \n</generation_prompt>'));
    assert.equal(text.match(/<module /g)?.length,1);
    assert.deepEqual([...text.matchAll(/<image_ref id="(image_\d+)"\/>/g)].map(m=>m[1]),['image_1','image_2']);
    if(input.kind==='native_blocks'){
      assert.match(text,/保留 image_1, image_2 的 &quot;A&amp;B&quot;/);
      assert.doesNotMatch(text,/编号 image_1/);
      for(const [index,b] of input.blocks!.entries())if(b.type==='image'){
        const label=input.blocks![index-1];assert.equal(label.type,'text');
        assert.equal(label.type==='text'?label.text:'',`<image_ref id="${b.image_name}"/>\n`);
      }
    }else {
      assert.match(text,/编号 image_1, image_2：保留 &lt;结构&gt; &amp; 比例。/);
      assert.doesNotMatch(text,/保留 image_1, image_2 的/);
    }
    if(version===4){
      assert.match(text,/<image_mapping>image_N refers to the Nth attached image \(1-based\), in attachment order\. Image numbers are independent of module numbers\.<\/image_mapping>/);
    }else assert.doesNotMatch(text,/<image_mapping>/);
    }
    const ids=input.kind==='native_blocks'?input.blocks!.filter(b=>b.type==='image').map(b=>b.asset_id):input.image_asset_ids;
    assert.deepEqual(ids,['asset_same','asset_same']);assert.deepEqual(chain,snapshot);assert.deepEqual(f.recipe,before);
  });
}

test('同类型模块和多个正文按原位置分别封闭，不合并、不重排，也不仲裁构图视角',()=>{
  const f=fixture(),composition=f.registry.create('composition'),viewpoint=f.registry.create('viewpoint'),secondSubject=f.registry.copy(f.subject),secondPrompt=f.registry.create('prompt');
  composition.user_instruction='构图保持当前视角';viewpoint.user_instruction='改为俯视';secondPrompt.user_instruction='第二段正文';
  f.recipe.modules=[f.prompt,composition,secondSubject,viewpoint,secondPrompt,f.subject];
  const output=adaptChain(compileRecipe(f.recipe,f.registry),seedModels()[1]).prompt!;
  const parts=[...output.matchAll(/<generation_prompt>|<module type="([a-z_]+)"/g)].map(m=>m[1]??'prompt');
  assert.deepEqual(parts,['prompt','composition','subject','viewpoint','prompt','subject']);
  assert.equal(output.match(/<\/generation_prompt>/g)?.length,2);assert.equal(output.match(/<\/module>/g)?.length,4);
  assert.match(output,/<requirements>构图保持当前视角<\/requirements>/);assert.match(output,/<requirements>改为俯视<\/requirements>/);
  assert.doesNotMatch(output,/priority=|overrides=|冲突/);
  const native=adaptChain(compileRecipe(f.recipe,f.registry),seedModels()[0]).blocks!;
  const nativeText=native.filter(b=>b.type==='text').map(b=>b.text).join('');
  assert.deepEqual([...nativeText.matchAll(/^## (\d+)\. (.+)$/gm)].map(m=>[m[1],m[2]]),[
    ['1','prompt'],['2','composition'],['3',f.subject.model_name],['4','viewpoint'],['5','prompt'],['6',f.subject.model_name],
  ]);
  assert.match(nativeText,/构图保持当前视角/);assert.match(nativeText,/改为俯视/);
  assert.doesNotMatch(nativeText,/priority=|overrides=|冲突/);
});

test('相同配方的理解编译保持版本2和既有格式，XML只进入普通生图',()=>{
  const f=fixture(),chain=compileRecipe(f.recipe,f.registry,{purpose:'understanding'});
  assert.equal(chain.format_version,2);
  const native=adaptChain(chain,seedModels()[0]),flat=adaptChain(chain,seedModels()[1]);
  assert.deepEqual(native.blocks,chain.blocks);assert.match(flat.prompt!,/^## 1\. 商品/);
  assert.doesNotMatch(flat.prompt!,/<generation_request>|<reference_rules>|<generation_prompt>/);
  assert.ok(flat.prompt!.includes(f.prompt.user_instruction));
});

test('自动比例的既有文字要求跟随图文 Markdown 或拍平 XML，参数不被移入正文',()=>{
  const f=fixture();f.recipe.core_parameters.aspect_ratio='auto';
  for(const strategy of ['interleaved','numbered_flat'] as const){
    f.recipe.input_strategy=strategy;
    const plan=planExecution(f.recipe,[{asset_id:'asset_same',width:600,height:400}],seedModels()[0],f.registry);
    const input=plan.adapted,text=input.kind==='native_blocks'?input.blocks!.filter(b=>b.type==='text').map(b=>b.text).join(''):input.prompt!;
    if(strategy==='numbered_flat')assert.match(text,/<requirements>期望输出画面的宽高比为 3:2。请尽量保持该比例。<\/requirements>\n<\/generation_request>$/);
    else {
      assert.match(text,/\n\n期望输出画面的宽高比为 3:2。请尽量保持该比例。$/);
      assert.doesNotMatch(text,/<generation_request>|<requirements>/);
    }
    assert.equal(text.match(/期望输出画面/g)?.length,1);
    assert.equal(plan.recipe.core_parameters.aspect_ratio,'auto');
  }
});

test('新图文标题按实际参与模块连续编号，空模块和文字参考过滤不打乱图片编号',()=>{
  const f=fixture(),empty=f.registry.create('subject'),disabled=f.registry.create('style'),textOnly=f.registry.create('style'),free=f.registry.create('image_text');
  disabled.enabled=false;disabled.asset_ids=['asset_disabled'];
  textOnly.reference_mode='text_only';textOnly.asset_ids=['asset_style'];textOnly.user_instruction='柔和侧光';
  free.asset_ids=['asset_free'];f.prompt.auto_prompt=true;
  f.recipe.modules=[empty,disabled,f.prompt,textOnly,free,f.subject];
  const chain=compileRecipe(f.recipe,f.registry),input=adaptChain(chain,seedModels()[0]),flat=adaptChain(chain,seedModels()[1]);
  const text=input.blocks!.filter(b=>b.type==='text').map(b=>b.text).join('');
  assert.deepEqual([...text.matchAll(/^## (\d+)\. (.+)$/gm)].map(m=>[m[1],m[2]]),[['1','prompt'],['2','image_text'],['3',f.subject.model_name]]);
  assert.deepEqual(input.blocks!.filter(b=>b.type==='image').map(b=>[b.image_name,b.asset_id]),[['image_1','asset_free'],['image_2','asset_same'],['image_3','asset_same']]);
  assert.deepEqual(flat.image_asset_ids,['asset_free','asset_same','asset_same']);
  assert.deepEqual([...flat.prompt!.matchAll(/<image_ref id="(image_\d+)"\/>/g)].map(m=>m[1]),['image_1','image_2','image_3']);
  assert.doesNotMatch(text,/柔和侧光|asset_style|asset_disabled/);
});

test('自定义非XML策略的用户文字恰好是结束标签时，不误插入结构化要求',()=>{
  const f=fixture();f.prompt.user_instruction='</generation_request>';
  const chain=compileRecipe(f.recipe,f.registry),block=chain.blocks.find(b=>b.type==='text'&&b.text===f.prompt.user_instruction)!;
  const input={kind:'native_blocks' as const,blocks:[block],adjustments:[]},before=structuredClone(input);
  assert.equal(appendGenerationXmlRequirement(input,'比例要求'),false);
  assert.deepEqual(input,before);
});
