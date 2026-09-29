// Serializable task definitions belong to modules; execution and UI do not branch on module type.
export interface ModuleInferenceTask {
  action_label: string;
  description: string;
  context_scope: 'enabled_modules' | 'target';
  requires_text: boolean;
  requires_images: boolean;
  text_only_label?: string;
  instruction: string;
  output_instruction: string;
}

export const promptOptimizationTask: ModuleInferenceTask = {
  action_label: '优化提示词',
  description: '结合启用模块的文字和图片，只优化当前文字。',
  context_scope: 'enabled_modules',
  requires_text: true,
  requires_images: false,
  text_only_label: '仅按文字优化',
  instruction: '你是图像生成提示词编辑助手。只优化 role=target 模块的 text。其它启用模块是只读约束：遵守主体身份、结构、颜色、比例、构图和视角等要求，不修改它们，也不重复抄写它们。\n'
    + '在约束内把场景、光线、氛围、材质和细节表达得更清晰协调，合理丰富为当前主体服务的画面内容。提升画面美感。不要擅自更换主体、添加标识或编造主体属性。',
  output_instruction: '返回优化后可直接替换当前文字的完整提示词。',
};

export const subjectAnalysisTask: ModuleInferenceTask = {
  action_label: '分析主体特征',
  description: '仅分析当前主体模块的图片和文字，描述结构、材质外观、颜色、比例及当前状态。',
  context_scope: 'target',
  requires_text: false,
  requires_images: true,
  instruction: '你是主体参考图分析助手。只依据当前主体模块的图片和用户文字，提取可用于图像生成的主体特征。\n'
    + '描述整体轮廓、部件数量与连接关系、位置、材质外观与表面纹理、光泽和透明度、各部件颜色、相对比例、开合或折叠及装配状态、可辨认的标识和细节。区分物体固有颜色与光照、阴影、反射造成的颜色。不要加入背景、构图、摄影风格或美化场景。\n'
    + '多张图片应相互核对；存在不同主体或矛盾特征时分别描述，不要强行合并。不推断不可见结构，不编造材料牌号、精确尺寸、遮挡细节或无法辨认的标识文字；不确定的内容应省略或明确不确定。\n'
    + '保留用户现有文字中的明确要求和事实。区分图片中的原始外观与用户要求的修改；冲突时明确表达修改要求，其余特征保持，不要把用户的改色等要求改回参考图原貌。',
  output_instruction: '返回可直接替换当前文字的完整主体描述，包含需要保留的用户要求。按部件和空间关系组织简洁、具体的文字；已有描述应整合去重，不要反复追加。',
};

// Shared entry conditions for the editor and privileged request boundary.
export function inferenceInputError(task: ModuleInferenceTask, text: string, imageCount: number, maxImages?: number): string | undefined {
  if (text.length > 32000) return '文字最多 32,000 字符。';
  if (task.requires_text && !text.trim()) return '请先填写要处理的文字。';
  if (task.requires_images && !imageCount) return '请先为当前模块添加参考图片。';
  if (task.requires_images && maxImages === 0) return '此任务需要看图，请选择支持图片的理解／推理模型。';
}
