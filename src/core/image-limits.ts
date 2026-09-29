// Storage budgets are separate from the selected channel's upload limits.
export const MB=1024*1024;
export const MAX_STORED_IMAGE_BYTES=192*MB; // Includes lossless full-resolution composites (40 MP decode limit).
export const MAX_IMAGES_FILE_MB=50;
export const MAX_IMAGES_REQUEST_MB=100;
export const MAX_GEMINI_REQUEST_MB=100;
export const MAX_MODEL_INPUT_BYTES=144*MB; // Base64 plus JSON overhead for a 100 MB upload.
export const MAX_CAPTURE_FILE_CHARS=4*Math.ceil(MAX_IMAGES_FILE_MB*MB/3);
export const MAX_CAPTURE_JSON_CHARS=MAX_GEMINI_REQUEST_MB*MB;

export function imagesUploadLimits(config?:{max_image_mb?:number;max_request_mb?:number}){
  return {fileMB:config?.max_image_mb??50,requestMB:config?.max_request_mb??50};
}
export function validateImagesUpload(fileBytes:number,totalBytes:number,config?:{max_image_mb?:number;max_request_mb?:number}){
  const limits=imagesUploadLimits(config);
  if(fileBytes>=limits.fileMB*MB)throw new Error(`图片或蒙版达到当前接入的单文件 ${limits.fileMB} MB 上限，请缩小送入范围或检查接口兼容设置。`);
  if(totalBytes>limits.requestMB*MB)throw new Error(`图片、蒙版与文字合计超过当前接入的 ${limits.requestMB} MB 请求预算，请缩小送入范围或检查接口兼容设置。`);
}

export function geminiUploadLimits(config?:{max_request_mb?:number}){
  return {requestMB:config?.max_request_mb??MAX_GEMINI_REQUEST_MB};
}
// The inline budget includes Base64 expansion, text and the final JSON envelope.
export function validateGeminiUpload(encodedBytes:number,config?:{max_request_mb?:number}){
  const {requestMB}=geminiUploadLimits(config);
  if(encodedBytes>requestMB*MB)throw new Error(`图文编码后的完整请求超过当前渠道的 ${requestMB} MB 内联请求预算，请缩小送入范围或检查接口兼容设置；未发送请求。`);
}
