import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateModels, librarySchema, type LibraryData } from '../src/core/model-library.js';
import { seedModels } from '../src/protocols/model-presets.js';
import { hasUserModels, initializeModelOrigins, isModelVisible } from '../src/core/model-visibility.js';

function fixture(): LibraryData { return migrateModels(seedModels()); }
function mockVisibility(data: LibraryData): boolean[] {
  return data.models.filter(model => model.kind === 'mock').map(model => isModelVisible(model, data));
}

test('fresh seed placeholders keep both built-in mock engines visible without mutating input', () => {
  const data = fixture(), before = structuredClone(data), initialized = initializeModelOrigins(data);
  assert.deepEqual(data, before);
  assert.ok(data.models.every(model => model.origin === undefined));
  assert.ok(initialized.models.every(model => model.origin === 'builtin'));
  assert.equal(hasUserModels(initialized), false);
  assert.deepEqual(mockVisibility(initialized), [true, true]);
  assert.deepEqual(librarySchema.parse(initialized), initialized);
  assert.deepEqual(initializeModelOrigins(initialized), initialized);
});

test('legacy configured seed models count as user models even without a usable credential', () => {
  const scenarios: [string, (data: LibraryData) => void][] = [
    ['credential reference', data => { data.connections[0].credential_ref = 'credential_missing'; }],
    ['generation assignment', data => { data.assignments.generation_default = 'model_nano_pro'; }],
    ['editing assignment', data => { data.assignments.editing_default = 'model_nano_pro'; }],
    ['model revision', data => { data.models[2].revision = 2; }],
    ['connection revision', data => { data.connections[0].revision = 2; }],
    ['changed model identity', data => { data.models[2].model = 'custom-image-model'; }],
    ['changed protocol identity', data => { data.models[2].adapter_id = 'custom-adapter'; }],
    ['changed purpose', data => { data.models[2].purpose = 'understanding'; data.assignments.understanding_default = 'model_nano_pro'; }],
  ];
  for (const [label, configure] of scenarios) {
    const data = fixture(); configure(data);
    const initialized = initializeModelOrigins(data);
    assert.equal(initialized.models[2].origin, 'user', label);
    assert.equal(hasUserModels(initialized), true, label);
    assert.deepEqual(mockVisibility(initialized), [false, false], label);
    assert.ok(initialized.models.filter(model => model.kind !== 'mock').every(model => isModelVisible(model, initialized)), label);
  }
});

test('recognized older GPT seed model and protocol identities remain built-in while unconfigured', () => {
  for (const model of ['gpt-image-2', 'gpt-image-2.5-sunburst']) {
    for (const adapter_id of ['openai-images', 'kuai-images']) {
      const data = fixture(); Object.assign(data.models[3], { model, adapter_id });
      const initialized = initializeModelOrigins(data);
      assert.equal(initialized.models[3].origin, 'builtin');
      assert.equal(hasUserModels(initialized), false);
    }
  }
});

test('explicit ownership survives cleared credentials, revisions, and reinitialization', () => {
  const data = fixture(); data.connections[0].credential_ref = 'credential_original';
  const initialized = initializeModelOrigins(data);
  delete initialized.connections[0].credential_ref;
  const reopened = initializeModelOrigins(initialized);
  assert.equal(reopened.models[2].origin, 'user');
  assert.equal(hasUserModels(reopened), true);
  assert.deepEqual(mockVisibility(reopened), [false, false]);

  reopened.models[3].revision = 5;
  reopened.connections[1].credential_ref = 'credential_explicit_builtin';
  assert.equal(initializeModelOrigins(reopened).models[3].origin, 'builtin');
});

test('disabled unready custom real models hide mocks until the final user model is removed', () => {
  const data = fixture();
  data.models.push({ ...structuredClone(data.models[2]), model_config_id: 'model_custom_disabled', enabled: false });
  data.models.push({ ...structuredClone(data.models[4]), model_config_id: 'model_custom_local', adapter_id: 'custom-local', model: 'custom-local-model' });
  const initialized = initializeModelOrigins(data);
  assert.equal(initialized.models.at(-2)?.origin, 'user');
  assert.equal(initialized.models.at(-1)?.origin, 'user');
  assert.deepEqual(mockVisibility(initialized), [false, false]);
  initialized.models.pop();
  assert.deepEqual(mockVisibility(initialized), [false, false]);
  initialized.models.pop();
  assert.deepEqual(mockVisibility(initialized), [true, true]);
});

test('a platform without an enrolled user model leaves mocks visible', () => {
  const data = fixture();
  data.connections.push({ connection_id: 'connection_custom', title: 'My platform', endpoint: 'https://example.com', enabled: true, revision: 1, credential_ref: 'credential_custom' });
  const initialized = initializeModelOrigins(data);
  assert.equal(hasUserModels(initialized), false);
  assert.deepEqual(mockVisibility(initialized), [true, true]);
});

test('mock engines do not count as user models even with explicit legacy ownership', () => {
  const data = fixture(); data.models[0].origin = 'user';
  const initialized = initializeModelOrigins(data);
  assert.equal(initialized.models[0].origin, 'user');
  assert.equal(hasUserModels(initialized), false);
  assert.deepEqual(mockVisibility(initialized), [true, true]);
});
