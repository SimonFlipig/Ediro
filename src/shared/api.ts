import type { Asset, CompiledChain, Job, ModuleDefinition, Project, PublicModel, Recipe, AdaptedInput } from '../core/domain.js';
import type { PublicConnection, ModelEntry, Connection, AdapterDescription, LibraryData } from '../core/model-library.js';
import type { ModelTestRecord } from '../core/model-tests.js';
import type { ModelInput } from '../core/model-input.js';
import type { PromptConfig } from '../core/prompt-config.js';
import type { ModuleInferenceSuggestion } from '../core/module-inference.js';

export interface ViewAsset extends Asset { preview_url: string; original_url: string; source_status?: 'available' | 'missing' | 'changed' }
export interface ProjectRecord {id:string;title:string;updated_at:string;preview_url?:string;result_count:number;location?:string;status:'running'|'draft'|'failed'|'saved'|'empty'|'unavailable'}
export interface WorkspaceView {
  prompt_config?:PromptConfig;
  model_tests?:ModelTestRecord[];
  connections?:PublicConnection[];
  adapters?:AdapterDescription[];
  assignments?:LibraryData['assignments'];
  project: Project | null;
  assets: ViewAsset[];
  models: PublicModel[];
  module_definitions: ModuleDefinition[];
  chain: CompiledChain | null;
  adaptation: AdaptedInput | null;
  adaptation_error?: string;
  project_location: string | null;
  project_record_id?:string;
  project_format?:'ediro'|'legacy'|'draft';
  project_storage_version?:1|2;
  save_state?:'saved'|'pending'|'saving'|'error';
  save_error?:string;
  recent_workspaces?: ProjectRecord[];
}
export type Command =
  | {type:'job:retry';project_id:string;task_id:string}
  | {type:'mask:save-composite';project_id:string;task_id:string;strokes:import('../core/mask.js').MaskStroke[]}
  | {type:'mask:preview';project_id:string;task_id:string;mode:import('../core/mask.js').MaskMode;feather:number;composite_strokes?:import('../core/mask.js').MaskStroke[]}
  | {type:'mask:save-draft';project_id:string;draft:import('../core/mask.js').MaskDraft}
  | {type:'mask:start';project_id:string;draft:import('../core/mask.js').MaskDraft}
  | {type:'mask:reprocess';project_id:string;task_id:string;mode:import('../core/mask.js').MaskMode;feather:number;composite_strokes?:import('../core/mask.js').MaskStroke[]}
  | {type:'recipe:select-model';model_config_id:string}
  | {type:'recipe:reset-parameters'}
  | {type:'module:infer';request_id:string;project_id:string;module_id:string;model_config_id:string;text:string;allow_text_only:boolean}
  | {type:'module:cancel-inference';request_id:string}
  | {type:'job:model-input';task_id:string}
  | {type:'model:test';model_config_id:string}
  | {type:'model:accept-test';test_id:string}
  | { type:'job:recover-result'; task_id:string }
  | { type:'connection:save'; connection:Omit<Connection,'revision'|'credential_ref'>; secret?:string; clear_credential?:boolean }
  | { type:'connection:delete'; connection_id:string }
  | { type:'model:save'; model:Omit<ModelEntry,'revision'> }
  | { type:'model:delete'; model_config_id:string }
  | { type:'model:assign'; purpose:ModelEntry['purpose']|'editing'; model_config_id:string }
  | { type:'connection:probe'; connection_id:string; adapter_id:string }
  | { type:'asset:hide'; asset_id:string }
  | { type:'result:trash'; asset_id:string }
  | { type:'result:restore'; project_id:string; asset_id:string }
  | { type:'workspace:remove'; id:string }
  | { type:'workspace:rename'; id:string;name:string }
  | { type:'output:open' }
  | { type:'output:folder' }
  | { type: 'state' }
  | { type: 'project:create'; name: string }
  | { type: 'project:open' }
  | { type: 'project:save' }
  | { type: 'recipe:save'; recipe: Recipe }
  | { type: 'module:add'; reference_type: string; before_module_id?: string }
  | { type: 'module:copy'; module_id: string }
  | { type: 'module:reference-type'; module_id: string; reference_type: string }
  | { type: 'module:tool'; module_id: string; png_base64: string; state: Record<string,unknown>; instruction: string }
  | { type: 'assets:import'; module_id?: string }
  | { type: 'assets:drop'; paths: string[]; module_id?: string }
  | { type: 'asset:relink'; asset_id: string }
  | { type: 'project:package' }
  | { type: 'workspace:resume'; id: string }
  | { type: 'model:update'; model_config_id: string; title: string; endpoint: string; enabled: boolean; secret?: string }
  | { type: 'job:start'; allow_degradation: boolean }
  | { type: 'job:cancel'; task_id: string }
  | { type: 'job:restore'; task_id: string }
  | { type: 'asset:export'; asset_id: string };
export interface ApiResponse { mask_preview?:string; selected_asset_id?:string; ok: boolean; state?: WorkspaceView; error?: string; cancelled?: boolean; discovered_models?:string[]; model_input?:ModelInput|null; suggestion?:ModuleInferenceSuggestion }
export interface DesktopApi {
  updates?: import('./updates.js').UpdateApi;
  onDialog?(listener:(request:DialogRequest)=>void):()=>void;
  respondDialog?(id:string,response:number):void;
  readonly windowControlsOverlay?: boolean;
  execute(command: Command): Promise<ApiResponse>;
  subscribe(listener: (state: WorkspaceView) => void): () => void;
  getFilePaths(files: File[]): string[];
  beforeClose?(listener:()=>Promise<boolean>):()=>void;
}
export type JobView = Job;
export interface DialogRequest { id:string; message:string; detail?:string; buttons:string[]; cancelId:number; defaultId:number }
