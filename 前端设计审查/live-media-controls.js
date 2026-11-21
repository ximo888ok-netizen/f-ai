import { field, h, input, select } from './live.js';

export const imageFiles=files=>files.filter(file=>['image/png','image/jpeg'].includes(file.mediaType));
export const fileOptions=files=>files.map(file=>[file.id,file.name]);
export const numeric=(label,name,value,min,max)=>field(label,input(name,
  'type="number" required min="'+min+'" max="'+max+'" value="'+h(value)+'"'));
export const mediaRatios=[['16:9','16:9 横屏'],['9:16','9:16 竖屏'],['1:1','1:1 方形']];
export function assetField(label,name,files,value,required=false,placeholder='不使用') {
  return field(label,select(name,[['',placeholder],...fileOptions(files)],value ?? '',required?'required':''));
}

export function toggleFields(root,selector,enabled) {
  const group=root.querySelector(selector);
  group.hidden=!enabled;
  for (const control of group.querySelectorAll('input, select, textarea')) control.disabled=!enabled;
}

export function rowControls(remove,canOrder=false) {
  return '<div class="live-row">'+(canOrder?'<button type="button" class="plain" data-row-command="up">上移</button>'+
    '<button type="button" class="plain" data-row-command="down">下移</button>':'')+
    '<button type="button" class="plain" data-row-command="remove">'+h(remove)+'</button></div>';
}

export function editRows(container,markup,limit,{update=()=>{}}={}) {
  const rows=container.querySelector('[data-edit-rows]');
  const add=container.querySelector('[data-row-command="add"]');
  const sync=()=>{
    const entries=[...rows.children];
    add.disabled=entries.length>=limit;
    for (const [index,row] of entries.entries()) {
      row.querySelector('[data-row-command="remove"]').disabled=entries.length===1;
      const up=row.querySelector('[data-row-command="up"]');
      const down=row.querySelector('[data-row-command="down"]');
      if (up) up.disabled=index===0;
      if (down) down.disabled=index===entries.length-1;
      update(row,index);
    }
  };
  container.addEventListener('click',event=>{
    const control=event.target.closest('[data-row-command]');
    if (!control || container.closest('form')?.dataset.pending) return;
    const row=control.closest('[data-edit-row]');
    switch (control.dataset.rowCommand) {
      case 'add':
        if (rows.children.length<limit) rows.insertAdjacentHTML('beforeend',markup());
        break;
      case 'remove':
        if (rows.children.length>1) row.remove();
        break;
      case 'up':
        if (row.previousElementSibling) row.previousElementSibling.before(row);
        break;
      case 'down':
        if (row.nextElementSibling) row.nextElementSibling.after(row);
        break;
    }
    sync();
  });
  container.addEventListener('change',event=>{
    const row=event.target.closest('[data-edit-row]');
    if (row) update(row,[...rows.children].indexOf(row));
  });
  sync();
}
