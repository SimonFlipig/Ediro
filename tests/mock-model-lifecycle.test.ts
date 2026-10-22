import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { ModelLibrary, seedModels } from '../src/core/models.js';
import { mockDescription } from '../src/core/model-library.js';
import { Workspace } from '../src/core/workspace.js';
import { planExecution } from '../src/core/execution-plan.js';
import type { Job } from '../src/core/domain.js';
import { GeminiGenerator } from '../src/adapters/gemini-generator.js';
import { ImagesGenerator } from '../src/adapters/images-generator.js';
import { ProjectRepository, atomicJson } from '../src/adapters/project-repository.js';
import { modelLibraryFilename, openModelLibrary } from '../src/adapters/model-library-repository.js';
import { modelFromPreset } from '../src/protocols/model-catalog.js';

async function fixture(t: test.TestContext) {
  const root = path.join(process.cwd(), '.local', 'test-mock-lifecycle');
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, 'case-'));
  const values = new Map<string, string>();
  const secrets = { has: async (ref: string) => values.has(ref), set: async (ref: string, key: string) => { values.set(ref, key); } };
  const adapters = [mockDescription, new GeminiGenerator().description, new ImagesGenerator().description];
  let failSave = false, executionCalls = 0;
  const persist = async (data: ReturnType<ModelLibrary['snapshot']>) => {
    if (failSave) throw new Error('fixture disk failure');
    await atomicJson(path.join(directory, modelLibraryFilename), data);
  };
  const library = new ModelLibrary(seedModels(), persist, secrets, adapters);
  const workspace = new Workspace(library, { execute: async () => { executionCalls++; throw new Error('This test must never execute a model.'); } });
  t.after(async () => { await workspace.shutdown(); });
  return {
    directory, library, workspace,
    rejectSaves: (value: boolean) => { failSave = value; },
    calls: () => executionCalls,
    reopen: async () => new ModelLibrary(await openModelLibrary(directory), persist, secrets, adapters),
  };
}

async function addPlatform(library: ModelLibrary, id = 'connection_user', secret?: string) {
  await library.saveConnection({ connection_id: id, title: 'User platform', adapter_id: 'gemini-generate-content', endpoint: 'https://fixture.invalid', enabled: true }, secret);
  return id;
}

async function enroll(library: ModelLibrary, id: string, purpose: 'generation' | 'understanding' = 'generation', connection = 'connection_user') {
  if (!library.snapshot().connections.some(item => item.connection_id === connection)) await addPlatform(library, connection);
  const { endpoint, executable, revision, ...model } = modelFromPreset(purpose === 'generation' ? 'nano-banana-pro' : 'gemini-3-1-pro', id, connection, 'fixture-' + id);
  await library.saveModel({ ...model, purpose, capability_source: 'documented' });
}

async function visibleMocks(library: ModelLibrary) {
  return (await library.list()).filter(model => model.kind === 'mock').map(model => model.model_config_id);
}
const mockIds = ['model_mock_native', 'model_mock_separated'];

test('adding only a platform with credentials keeps both mock engines visible', async t => {
  const { library } = await fixture(t);
  await addPlatform(library, 'connection_only', 'fixture-key');
  assert.deepEqual(await visibleMocks(library), mockIds);
  assert.equal(library.defaultModel(), 'model_mock_native');
  assert.equal(library.snapshot().models.filter(model => model.kind === 'mock').length, 2);
  await assert.rejects(() => library.deleteModel('model_mock_native'), /不能移除/);
});

test('enrolling either model purpose hides both mocks immediately without selecting a paid default', async t => {
  for (const purpose of ['generation', 'understanding'] as const) {
    await t.test(purpose, async child => {
      const { library } = await fixture(child);
      await enroll(library, 'model_user', purpose);
      assert.deepEqual(await visibleMocks(library), []);
      assert.equal(library.defaultModel(), undefined);
      assert.deepEqual(library.effectiveAssignments(), {});
      assert.equal(library.snapshot().models.find(model => model.model_config_id === 'model_user')?.origin, 'user');
      assert.equal((await library.list()).find(model => model.model_config_id === 'model_user')?.executable, false);
      await assert.rejects(() => library.execution('model_mock_native'), /真实模型|重新选择/);
      await assert.rejects(() => library.assign('generation', 'model_mock_native'), /隐藏/);
    });
  }
});

test('disabled real models and cleared credentials retain hidden mocks after persistence and reload', async t => {
  const { library, reopen } = await fixture(t);
  await addPlatform(library, 'connection_user', 'fixture-key');
  await enroll(library, 'model_user');
  const entry = library.snapshot().models.find(model => model.model_config_id === 'model_user')!;
  await library.saveModel({ ...entry, enabled: false });
  const connection = library.snapshot().connections.find(item => item.connection_id === 'connection_user')!;
  await library.saveConnection({ ...connection, enabled: false }, undefined, true);
  assert.deepEqual(await visibleMocks(library), []);
  const restored = await reopen();
  assert.deepEqual(await visibleMocks(restored), []);
  assert.equal(restored.snapshot().models.find(model => model.model_config_id === 'model_user')?.origin, 'user');
  assert.equal(restored.snapshot().connections.find(item => item.connection_id === 'connection_user')?.credential_ref, undefined);
});

test('removing user defaults clears each role and restores mocks only after the last user model is removed', async t => {
  const { library, reopen } = await fixture(t);
  await enroll(library, 'model_generation');
  await enroll(library, 'model_reasoning', 'understanding');
  await library.assign('generation', 'model_generation');
  await library.assign('editing', 'model_generation');
  await library.assign('understanding', 'model_reasoning');
  assert.deepEqual(library.effectiveAssignments(), { generation_default: 'model_generation', understanding_default: 'model_reasoning', editing_default: 'model_generation' });
  await library.deleteModel('model_generation');
  assert.deepEqual(library.snapshot().assignments, { understanding_default: 'model_reasoning' });
  assert.deepEqual(await visibleMocks(library), []);
  assert.equal(library.defaultModel(), undefined);
  await library.deleteModel('model_reasoning');
  assert.deepEqual(library.snapshot().assignments, {});
  assert.deepEqual(library.effectiveAssignments(), { generation_default: 'model_mock_native' });
  assert.deepEqual(await visibleMocks(library), mockIds);
  assert.ok(library.snapshot().connections.some(item => item.connection_id === 'connection_user'));
  const restored = await reopen();
  assert.deepEqual(await visibleMocks(restored), mockIds);
  assert.equal(restored.defaultModel(), 'model_mock_native');
});

test('a reasoning-only library creates an editable unselected workspace and blocks generation', async t => {
  const { directory, library, workspace, calls } = await fixture(t);
  await enroll(library, 'model_reasoning', 'understanding');
  await library.assign('understanding', 'model_reasoning');
  const repository = new ProjectRepository(path.join(directory, 'project'));
  await workspace.create(repository, 'Reasoning only');
  assert.equal(workspace.project!.recipe.model_config_id, 'model_unselected');
  const recipe = structuredClone(workspace.project!.recipe);
  recipe.modules.at(-1)!.user_instruction = '可以编辑提示词，稍后添加生图模型。';
  await workspace.saveRecipe(recipe);
  await workspace.addModule('prompt');
  assert.equal((await repository.load()).recipe.modules[3].user_instruction, recipe.modules[3].user_instruction);
  await workspace.open(repository);
  assert.equal(workspace.project!.recipe.model_config_id, 'model_unselected');
  assert.equal(workspace.project!.recipe.modules.length, 5);
  await assert.rejects(() => workspace.enqueue(false), /先选择生图模型/);
  await assert.rejects(() => workspace.selectModel('model_mock_native'), /真实模型|重新选择/);
  assert.equal(calls(), 0);
  assert.equal(workspace.project!.jobs.length, 0);
});

test('existing mock recipes and historical snapshots survive hiding while selection and execution are rejected', async t => {
  const { directory, library, workspace, calls } = await fixture(t);
  const repository = new ProjectRepository(path.join(directory, 'project'));
  await workspace.create(repository, 'Historical mock');
  const recipe = structuredClone(workspace.project!.recipe);
  recipe.modules.at(-1)!.user_instruction = '历史模拟提示词';
  await workspace.saveRecipe(recipe);
  const model = library.resolve('model_mock_native');
  const plan = planExecution(workspace.project!.recipe, [], model, workspace.registry);
  const history: Job = {
    task_id: 'task_mock_history', status: 'failed', stage: '历史模拟', progress: 0,
    created_at: new Date().toISOString(), finished_at: new Date().toISOString(), error: '历史测试记录',
    recipe_snapshot: structuredClone(workspace.project!.recipe), chain_snapshot: plan.chain, adapted_input: plan.adapted,
    model_snapshot: { model_config_id: model.model_config_id, title: model.title, provider: model.provider, model: model.model, adapter_id: model.adapter_id, revision: model.revision, kind: model.kind },
    output_asset_ids: [],
  };
  workspace.project!.jobs.push(history);
  await workspace.persist();
  const beforeRecipe = structuredClone(workspace.project!.recipe), beforeHistory = structuredClone(history);
  await enroll(library, 'model_user');
  assert.deepEqual(workspace.project!.recipe, beforeRecipe);
  assert.deepEqual(workspace.project!.jobs[0], beforeHistory);
  await assert.rejects(() => workspace.enqueue(false), /真实模型|重新选择/);
  await assert.rejects(() => workspace.retry(workspace.project!.project_id, history.task_id), /真实模型|重新选择/);
  await assert.rejects(() => workspace.selectModel('model_mock_native'), /真实模型|重新选择/);
  await workspace.open(repository);
  assert.deepEqual(workspace.project!.recipe, beforeRecipe);
  assert.deepEqual(workspace.project!.jobs[0], beforeHistory);
  const edited = structuredClone(workspace.project!.recipe);
  edited.modules.at(-1)!.user_instruction = '模型暂不可用时仍可编辑';
  await workspace.saveRecipe(edited);
  assert.equal((await repository.load()).recipe.model_config_id, 'model_mock_native');
  assert.deepEqual((await repository.load()).jobs[0], beforeHistory);
  assert.equal(calls(), 0);
});

test('failed saves leave visibility, ownership and effective defaults unchanged', async t => {
  const { library, rejectSaves } = await fixture(t);
  await addPlatform(library);
  const before = library.snapshot(), beforeList = await library.list(), beforeDefaults = library.effectiveAssignments();
  rejectSaves(true);
  await assert.rejects(() => enroll(library, 'model_user'), /fixture disk failure/);
  assert.deepEqual(library.snapshot(), before);
  assert.deepEqual(await library.list(), beforeList);
  assert.deepEqual(library.effectiveAssignments(), beforeDefaults);
  const seedConnection = library.snapshot().connections[0];
  await assert.rejects(() => library.saveConnection(seedConnection, 'fixture-key'), /fixture disk failure/);
  assert.deepEqual(library.snapshot(), before);
  assert.deepEqual(await visibleMocks(library), mockIds);
  rejectSaves(false);
  await enroll(library, 'model_user');
  await library.assign('generation', 'model_user');
  const enrolled = library.snapshot(), enrolledList = await library.list(), enrolledDefaults = library.effectiveAssignments();
  rejectSaves(true);
  await assert.rejects(() => library.deleteModel('model_user'), /fixture disk failure/);
  assert.deepEqual(library.snapshot(), enrolled);
  assert.deepEqual(await library.list(), enrolledList);
  assert.deepEqual(library.effectiveAssignments(), enrolledDefaults);
});

test('configuring an existing bundled cloud seed hides mocks and clearing its key does not restore them', async t => {
  const { library, reopen } = await fixture(t);
  const connection = library.snapshot().connections[0];
  await library.saveConnection(connection, 'fixture-key');
  assert.equal(library.snapshot().models.find(model => model.model_config_id === 'model_nano_pro')?.origin, 'user');
  assert.deepEqual(await visibleMocks(library), []);
  await library.saveConnection(connection, undefined, true);
  assert.deepEqual(await visibleMocks(library), []);
  const restored = await reopen();
  assert.deepEqual(await visibleMocks(restored), []);
  await restored.deleteModel('model_nano_pro');
  assert.deepEqual(await visibleMocks(restored), mockIds);
});

test('legacy libraries regain missing bundled mocks without changing an existing mock configuration', async t => {
  const { library } = await fixture(t);
  await enroll(library, 'model_user');
  await library.assign('generation', 'model_user');
  for (const keepExisting of [false, true]) {
    const legacy = library.snapshot();
    legacy.models = legacy.models.filter(model => model.kind !== 'mock' || keepExisting && model.model_config_id === 'model_mock_native');
    const existing = legacy.models.find(model => model.kind === 'mock');
    if (existing) {
      existing.title = '旧版本中修改过的模拟名称';
      existing.defaults.aspect_ratio = '16:9';
      existing.revision = 7;
    }
    const before = structuredClone(existing);
    const restored = new ModelLibrary(legacy, async () => {}, { has: async () => false, set: async () => {} }, library.adapters);
    assert.deepEqual(restored.snapshot().models.filter(model => model.kind === 'mock').map(model => model.model_config_id).sort(), mockIds);
    if (before) assert.deepEqual(restored.snapshot().models.find(model => model.model_config_id === before.model_config_id), before);
    assert.deepEqual(await visibleMocks(restored), []);
    await restored.deleteModel('model_user');
    assert.deepEqual((await visibleMocks(restored)).sort(), mockIds);
    const reopened = new ModelLibrary(restored.snapshot(), async () => {}, { has: async () => false, set: async () => {} }, library.adapters);
    assert.equal(reopened.snapshot().models.filter(model => model.kind === 'mock').length, 2);
    if (before) assert.deepEqual(reopened.snapshot().models.find(model => model.model_config_id === before.model_config_id), before);
  }
});

test('editing an unconfigured example keeps it built-in until a real model binding is created or configured', async t => {
  const { library, reopen } = await fixture(t);
  library.adapters.push({ adapter_id: 'local-pending', version: 1, title: 'Local placeholder', kind: 'local', installed: false, purposes: ['generation'], requires_credential: false, supports_probe: false, interleaving: ['native'], operations: [], parameters: [] });
  const seed = library.snapshot().models.find(model => model.model_config_id === 'model_nano_pro')!;
  await library.saveModel({ ...seed, title: '自定义示例显示名', defaults: { ...seed.defaults, aspect_ratio: '16:9' } });
  const local = library.snapshot().models.find(model => model.model_config_id === 'model_local_pending')!;
  await library.saveModel({ ...local, title: '尚未选择本地模型' });
  for (const id of ['model_nano_pro', 'model_local_pending']) assert.equal(library.snapshot().models.find(model => model.model_config_id === id)?.origin, 'builtin');
  assert.deepEqual(await visibleMocks(library), mockIds);
  const reopened = await reopen();
  assert.deepEqual(await visibleMocks(reopened), mockIds);
  assert.equal(reopened.snapshot().models.find(model => model.model_config_id === 'model_nano_pro')?.title, '自定义示例显示名');
  assert.equal(reopened.snapshot().models.find(model => model.model_config_id === 'model_local_pending')?.origin, 'builtin');

  for (const scenario of ['new-entry', 'platform-binding', 'remote-model-id', 'adapter', 'existing-credential'] as const) {
    await t.test(scenario, async child => {
      const current = await fixture(child);
      let target = current.library;
      const entry = target.snapshot().models.find(model => model.model_config_id === 'model_nano_pro')!;
      let expectedId = entry.model_config_id;
      if (scenario === 'new-entry' || scenario === 'platform-binding') {
        const connection = await addPlatform(target, 'connection_second');
        if (scenario === 'new-entry') expectedId = 'model_added_from_example';
        await target.saveModel({ ...entry, model_config_id: expectedId, connection_id: connection });
      } else if (scenario === 'remote-model-id') {
        await target.saveModel({ ...entry, model: 'my-real-image-alias' });
      } else if (scenario === 'adapter') {
        const { endpoint, executable, revision, ...images } = modelFromPreset('gpt-image-2-5-sunburst', entry.model_config_id, entry.connection_id!, 'my-real-images-model');
        await target.saveModel({ ...images, purpose: 'generation', capability_source: 'documented' });
      } else {
        const configured = target.snapshot();
        configured.connections.find(connection => connection.connection_id === entry.connection_id)!.credential_ref = 'credential_already_configured';
        target = new ModelLibrary(configured, async () => {}, { has: async () => true, set: async () => {} }, target.adapters);
        assert.deepEqual(await visibleMocks(target), mockIds);
        await target.saveModel({ ...entry, title: '保存已配置的示例模型' });
      }
      assert.equal(target.snapshot().models.find(model => model.model_config_id === expectedId)?.origin, 'user');
      assert.deepEqual(await visibleMocks(target), []);
    });
  }
});
