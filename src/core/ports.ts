import type { Asset, Job, ModelConfig, Project } from './domain.js';
import type { ModelInput } from './model-input.js';

export interface ProjectStorePort {
  readonly transient?:boolean;
  saveInternalImage(bytes:Buffer,name:string,role?:'input'|'internal'):Promise<Asset>;
  readonly directory: string;
  create(project: Project): Promise<void>;
  load(): Promise<Project>;
  save(project: Project): Promise<void>;
  importImage(filename: string): Promise<Asset>;
  readAsset(asset: Asset): Promise<Buffer>;
  saveOutput(bytes: Buffer, name: string, format: 'png' | 'jpeg' | 'webp'): Promise<Asset>;
  relinkImage(asset: Asset, filename: string): Promise<Asset>;
  saveOutputRecords(project: Project, job: Job): Promise<void>;
  stageResult(job:Job,result:ExecutionResult):Promise<void>;
  pendingResult(taskId:string):Promise<ExecutionResult>;
  clearPendingResult(taskId:string):Promise<void>;
  saveModelInput(taskId:string,input:ModelInput):Promise<void>;
  loadModelInput(taskId:string):Promise<ModelInput|null>;
}
export interface CloudExecutionContext {
  text_output_limit?:number;
  job: Job;
  model: ModelConfig;
  // Lazy reads preserve rich-media ordering without loading all image bytes
  // into memory up front. Only assets present in this job may be requested.
  readImage(assetId: string): Promise<Buffer>;
  resolveCredential(): Promise<string>;
  recordModelInput?(input:ModelInput):Promise<void>;
}
export interface ExecutionResult {
  images: { bytes: Buffer; format: 'png' | 'jpeg' | 'webp'; width: number; height: number }[];
  text?: string;
  request_id?: string;
  usage?: Record<string,number>;
}
export interface CloudExecutionPort {
  execute(context: CloudExecutionContext, signal: AbortSignal,
    progress: (stage: string, value: number) => Promise<void>): Promise<ExecutionResult>;
}
