import { AppDialog } from './AppDialog.js';

export function SettingsConfirmation({title,description,confirmLabel,onConfirm,onCancel}:{title:string;description:string;confirmLabel:string;onConfirm:()=>Promise<boolean>;onCancel:()=>void}) {
  return <AppDialog title={title} onDismiss={onCancel} actions={[
    {label:'取消',run:onCancel},
    {label:confirmLabel,primary:true,run:async()=>{if(!await onConfirm())throw new Error('操作未完成，请检查错误提示后重试，或取消返回。');}},
  ]}>{description}</AppDialog>;
}
