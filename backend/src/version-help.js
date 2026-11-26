import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { ApiError } from './http.js';

const version='v1';
const url='/v1/help/'+version+'/workbench.md';
async function guide() {
  let content;
  try { content=await readFile(new URL('./help/workbench-v1.md',import.meta.url)); }
  catch { throw new ApiError(503,'HELP_UNAVAILABLE','The bundled guide is unavailable'); }
  return {content,sha256:createHash('sha256').update(content).digest('hex')};
}

export function registerVersionHelp(app) {
  app.get('/v1/help',{schema:{tags:['Help'],summary:'Find the workbench guide shipped with this running release'}},async ()=>{
    const revision=process.env.FAI_RELEASE_REVISION;
    const {sha256}=await guide();
    return {version,revision:/^[a-f0-9]{40}$/.test(revision ?? '')?revision:null,
      locale:'zh-CN',title:'F-AI 工作台操作指南',url,sha256};
  });
  app.get(url,{schema:{tags:['Help'],summary:'Read the bundled workbench guide',produces:['text/markdown']}},async (_request,reply)=>{
    const {content,sha256}=await guide();
    return reply.header('etag','"'+sha256+'"').header('cache-control','no-cache').type('text/markdown; charset=utf-8').send(content);
  });
}
