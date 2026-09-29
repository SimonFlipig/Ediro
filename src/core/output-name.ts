import type {Asset} from './domain.js';

export function outputFilename(asset:Pick<Asset,'asset_id'|'created_at'|'mime_type'>){
  const date=new Date(asset.created_at),pad=(value:number)=>String(value).padStart(2,'0');
  const stamp=`${date.getFullYear()}${pad(date.getMonth()+1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `Ediro_${stamp}_${asset.asset_id.slice(-8)}.${asset.mime_type.split('/')[1]}`;
}
