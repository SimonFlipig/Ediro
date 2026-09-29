export interface ViewpointState {
  yaw: number;
  pitch: number;
  roll: number;
  projection?: 'orthographic' | 'perspective';
}

// Rz * Rx * Ry matches the renderer. Negative yaw exposes the product's
// right face; negative pitch looks down. Roll changes framing, not direction.
// These are descriptive ranges, not changes to the exact saved angles.
export function describeViewpoint(state: ViewpointState) {
  const yaw=Math.max(-180,Math.min(180,Number.isFinite(state.yaw)?state.yaw:0));
  const pitch=Math.max(-90,Math.min(90,Number.isFinite(state.pitch)?state.pitch:0));
  const roll=Math.max(-180,Math.min(180,Number.isFinite(state.roll)?state.roll:0));
  const horizontal=Math.abs(yaw),vertical=Math.abs(pitch);
  const side=yaw<0?'right':'left',sideZh=yaw<0?'右':'左';
  let direction:string,directionZh:string;
  if(vertical>=75){direction=pitch<0?'Top-down view':'Bottom view';directionZh=pitch<0?'完全俯视':'底部仰视';}
  else if(horizontal<=3){direction='Symmetrical front view';directionZh='对称正面视角';}
  else if(horizontal<=15){direction='Front view';directionZh='正面视角';}
  else if(horizontal<75){direction=`Front-${side} three-quarter view`;directionZh=`${sideZh}前方三分之四视角`;}
  else if(horizontal<=105){direction=`${side==='right'?'Right':'Left'} side view`;directionZh=`${sideZh}侧视角`;}
  else if(horizontal<165){direction=`Rear-${side} three-quarter view`;directionZh=`${sideZh}后方三分之四视角`;}
  else{direction='Rear view';directionZh='背面视角';}
  const elevation=vertical>=75?'':vertical<=18?'Eye-level shot':pitch<0?'High-angle view':'Low-angle view';
  const elevationZh=vertical>=75?'':vertical<=18?'平视':pitch<0?'俯视':'仰视';
  const orthographic=state.projection!=='perspective';
  const isometric=orthographic&&Math.min(Math.abs(horizontal-45),Math.abs(horizontal-135))<=1&&Math.abs(vertical-35.2643897)<=1;
  const projection=orthographic?(isometric?'Isometric view (orthographic)':'Orthographic view'):'Perspective view';
  const projectionZh=orthographic?(isometric?'等轴测（正交）':'正交'):'透视';
  const tilt=Math.abs(roll)>=165?'Upside-down framing':Math.abs(roll)>=15?(roll>0?'Clockwise tilt':'Counterclockwise tilt'):'';
  const tiltZh=Math.abs(roll)>=165?'倒置画面':Math.abs(roll)>=15?(roll>0?'顺时针倾斜':'逆时针倾斜'):'';
  return {
    direction,elevation,projection,tilt,
    promptValue:[direction,elevation].filter(Boolean).join(', '),
    summaryZh:[directionZh,elevationZh,projectionZh,tiltZh].filter(Boolean).join(' · '),
  };
}
