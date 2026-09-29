import type { CurrentPromptConfig } from './prompt-config.js';

// Approved first-release defaults. Keep this snapshot independent of private tuning data.
export const releasePromptConfig: CurrentPromptConfig = {
  revision: 'ediro-input-v2',
  module_header: '## {module_number}. {module}\n',
  image_label: '',
  image_separator: ', ',
  modules: {
    prompt: { header: false },
    image_text: { header: false },
    subject: {
      model_name: 'subject',
      native_instruction: "Preserve the subject's structure, colors, and proportions as shown in {images}\n",
      numbered_instruction: "Preserve the subject's structure, colors, and proportions as shown in {images}",
    },
    composition: {
      native_instruction: 'Use the following {images} as references for the overall composition, subject placement, and spatial relationships between elements.\n',
      numbered_instruction: 'Use the following {images} as references for the overall composition, subject placement, and spatial relationships between elements.',
    },
    viewpoint: {
      native_instruction: 'Adjust the camera viewpoint to "{viewpoint}" so the entire image matches the viewing angle and perspective shown in this reference image.',
      numbered_instruction: 'Adjust the camera viewpoint to "{viewpoint}" so the entire image matches the viewing angle and perspective shown in {images}',
    },
  },
  version: 2,
  intra_module_separator: '',
  inter_module_separator: '\n\n',
};
