import { z } from 'zod';

export const promptRoleSchema = z.enum(['general','merchandiser']);
export type PromptRole = z.infer<typeof promptRoleSchema>;

export const promptRoles: ReadonlyArray<{id:PromptRole;title:string;description:string;instruction:string}> = [
  {
    id:'general',title:'通用',
    description:'综合模块条件，明确画面要求，组织完整、协调的提示词。',
    instruction:'Act as an image-generation prompt editor. Clarify and coordinate the scene into clear, coherent visual requirements.',
  },
  {
    id:'merchandiser',title:'陈列师',
    description:'根据商品与模块条件，设计道具、材质、光线和陈列层次，突出商品。',
    instruction:'Act as a commercial product stylist and set designer. Create a cohesive scene that highlights the product. Develop purposeful props, surfaces, lighting, and visual hierarchy where unspecified. Follow composition constraints and design the remaining layout.',
  },
];

// Missing roles in existing projects retain their original general behavior.
// Startup defaults apply when creating a module, never when reading one.
export function resolvePromptRole(module:{prompt_role?:PromptRole}):PromptRole{
  return module.prompt_role??'general';
}
