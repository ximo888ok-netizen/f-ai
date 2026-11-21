export async function downloadFile(ctx,url,name,options={}) {
  const response=await ctx.api(url,{...options,raw:true});
  const blob=await response.blob();
  if (!ctx.active()) return;
  const objectUrl=URL.createObjectURL(blob);
  const anchor=document.createElement('a');
  anchor.href=objectUrl;
  anchor.download=name;
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(objectUrl),3000);
}
