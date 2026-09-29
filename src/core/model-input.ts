import { z } from 'zod';
import {MAX_CAPTURE_FILE_CHARS,MAX_CAPTURE_JSON_CHARS} from './image-limits.js';

const fileSchema=z.object({filename:z.string().max(200),mime_type:z.enum(['image/png','image/jpeg','image/webp']),data_base64:z.string().max(MAX_CAPTURE_FILE_CHARS)}).strict();
export const modelInputSchema=z.object({
  version:z.literal(1),adapter_id:z.string().max(80),captured_at:z.string(),
  route:z.string().max(500).regex(/^\/[a-zA-Z0-9_./:%-]+$/),
  body:z.discriminatedUnion('encoding',[
    z.object({encoding:z.literal('json'),json:z.string().max(MAX_CAPTURE_JSON_CHARS).refine(value=>{try{JSON.parse(value);return true;}catch{return false;}},'模型输入 JSON 无效。')}).strict(),
    z.object({encoding:z.literal('multipart'),fields:z.array(z.object({name:z.string().max(80),value:z.union([z.string().max(64000),fileSchema])}).strict()).max(100)}).strict(),
    z.object({encoding:z.literal('simulation'),blocks:z.array(z.unknown()).max(5000)}).strict(),
  ]),
}).strict();
export type ModelInput=z.infer<typeof modelInputSchema>;
