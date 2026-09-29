// description 仅用于界面。native/numbered 是发送指令，勿用说明替换。
// {images} 由程序替换为实际输入图片序号；视角模块可选用 {viewpoint}。
export const semanticPrompts:Record<string,{description:string;native:string;numbered:string}>={
  subject:{description:'保持商品的结构、颜色和比例。',native:'保持主体结构、颜色和比例。',numbered:'保持{images}中主体的结构、颜色和比例。'},
  composition:{description:'参考画面布局与主体位置。',native:'参考画面布局、主体位置与空间关系。',numbered:'参考{images}的画面布局、主体位置与空间关系。'},
  style:{description:'参考画面的色调、光影与风格。',native:'参考视觉风格、色调与光影表现。',numbered:'参考{images}的视觉风格、色调与光影表现。'},
  viewpoint:{description:'按参考视角调整商品的观察方向。',native:'Change the camera angle of the product to match the viewpoint shown in this reference image.',numbered:'Change the camera angle to match the viewpoint in {images} for this product.'},
};
export function validateNumberedTemplate(template:string){
  const remainder=template.replace('{images}','').split('{viewpoint}').join('');
  if(template.length>32000||(template.match(/\{images\}/g)??[]).length!==1||/[{}]/.test(remainder))throw new Error('图片语义模板必须包含且只包含一个 {images} 占位符，并可选用 {viewpoint}。');
  return template;
}
