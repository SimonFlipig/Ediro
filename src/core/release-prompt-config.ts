import type { CurrentPromptConfig } from './prompt-config.js';

// Approved release defaults. Keep this snapshot independent of private tuning data.
export const releasePromptConfig: CurrentPromptConfig = {
  revision: 'ediro-release-prompts-v3',
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
    style: {
      native_instruction: 'Use the following images in this style module only as references for environment type, props, accessories, color palette, and lighting. Do not use them to determine composition, object placement, relative scale, or spatial relationships.',
      numbered_instruction: 'Use {images} only as references for environment type, props, accessories, color palette, and lighting. Do not use these images to determine composition, object placement, relative scale, or spatial relationships.',
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
