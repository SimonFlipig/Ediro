// Fixed synthetic fixtures, never user files. This helper is not shipped in
// the desktop renderer and does not invoke any image-generation API.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { Workspace } from '../dist-host/core/workspace.js';
import { ModelLibrary, seedModels } from '../dist-host/core/models.js';
import { ProjectRepository, projectFilename } from '../dist-host/adapters/project-repository.js';
import { MockGenerator } from '../dist-host/adapters/mock-generator.js';

export async function createPreviewFixtures() {
  await mkdir('.local/demo-projects', { recursive: true });
  await mkdir('.local/fixtures-v2', { recursive: true });
  const directory = await mkdtemp(path.resolve('.local/demo-projects/work-'));
  const workspace = new Workspace(new ModelLibrary(seedModels(), async () => {}, { has: async () => false, set: async () => {} }), new MockGenerator(10));
  await workspace.create(new ProjectRepository(directory), '胡桃木 · 电商视觉试验');
  const fixtures = [
    ['product', '#eee9df', '<rect x="220" y="110" width="160" height="370" rx="22" fill="#75856b"/><rect x="230" y="105" width="140" height="40" rx="10" fill="#425640"/><rect x="248" y="245" width="104" height="110" rx="4" fill="#f6f1e5"/>'],
    ['composition', '#e9dfcb', '<rect y="390" width="600" height="210" fill="#c7ac81"/><rect x="40" y="40" width="210" height="300" fill="#faf5e6"/><path d="M145 40v300M40 190h210" stroke="#d9c3a0" stroke-width="8"/><rect x="410" y="230" width="95" height="215" rx="16" fill="#81916f"/>'],
    ['style', '#ac8253', '<path d="M30 0q170 150 10 350t80 300M150 0q160 180 0 360t70 270M300 0q150 140 10 340t60 300M450 0q170 200 0 400t80 200" stroke="#78502e" stroke-width="8" fill="none" opacity=".4"/>'],
  ];
  for (let index = 0; index < fixtures.length; index++) {
    const [name, background, drawing] = fixtures[index];
    const image = path.resolve(`.local/fixtures-v2/${name}.png`);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><rect width="600" height="600" fill="${background}"/>${drawing}</svg>`;
    await sharp(Buffer.from(svg)).png().toFile(image);
    await workspace.importFiles([image], workspace.project.recipe.modules[index].module_id);
  }
  const recipe = structuredClone(workspace.project.recipe);
  ['保留瓶身标识，商品使用正面视角。', '商品置于画面右侧，左侧留出文案空间。', '自然暖光、胡桃木台面，克制而温暖。', '生成 1:1 电商场景主视觉，呈现高端自然护肤品。'].forEach((text, i) => recipe.modules[i].user_instruction = text);
  await workspace.saveRecipe(recipe);
  const projectFile = path.join(directory, projectFilename);
  await writeFile('.local/preview-v2-project-path.txt', projectFile);
  return projectFile;
}
