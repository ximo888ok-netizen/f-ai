import { parentPort, workerData } from 'node:worker_threads';
import { createCanvas } from '@napi-rs/canvas';
import { drawAiBadge, metadata } from './ai-export-mark.js';
import { decodeImage, drawFitted } from './raster.js';

const mix=(source,target,weight)=>source+(target-source)*weight;

function pixels(ctx,image) {
  ctx.clearRect(0,0,image.width,image.height);
  ctx.drawImage(image,0,0);
  return ctx.getImageData(0,0,image.width,image.height);
}

function editImage(subject,mask,replacement,edit) {
  const {width,height}=subject;
  for (const image of [mask,replacement].filter(Boolean)) {
    if (image.width!==width || image.height!==height || width*height>4_000_000) {
      return null;
    }
  }
  const canvas=createCanvas(width,height);
  const ctx=canvas.getContext('2d');
  const raster=pixels(ctx,subject);
  const weights=pixels(ctx,mask).data;
  const region=replacement && pixels(ctx,replacement).data;
  const color=edit.color && edit.color.slice(1).match(/.{2}/g).map(value=>parseInt(value,16));
  for (let i=0;i<raster.data.length;i+=4) {
    const weight=(weights[i]+weights[i+1]+weights[i+2])*weights[i+3]/(3*255*255);
    if (edit.method==='cutout') {
      raster.data[i+3]*=weight;
    } else if (weight && color) {
      const shade=(0.2126*raster.data[i]+0.7152*raster.data[i+1]+0.0722*raster.data[i+2])/255;
      for (let channel=0;channel<3;channel++) raster.data[i+channel]=mix(raster.data[i+channel],color[channel]*shade,weight);
    } else if (weight && region) {
      for (let channel=0;channel<4;channel++) raster.data[i+channel]=mix(raster.data[i+channel],region[i+channel],weight);
    }
  }
  ctx.putImageData(raster,0,0);
  return canvas;
}

async function render({job,sources}) {
  if (sources.some(source=>!source)) return {error:'SOURCE_UNAVAILABLE'};
  const byId=new Map();
  try {
    for (const source of sources) {
      if (!byId.has(source.id)) byId.set(source.id,await decodeImage(source.data));
    }
  } catch { return {error:'SOURCE_INVALID'}; }
  const images=job.assetIds.map(id=>byId.get(id));
  if (job.edit) {
    const {maskAssetId,replacementAssetId}=job.edit;
    images[0]=editImage(images[0],byId.get(maskAssetId),byId.get(replacementAssetId),job.edit);
    if (!images[0]) return {error:'MASK_DIMENSIONS'};
  }
  const {fit,background,backdrop,mediaType,scale}=job;
  const width=scale?images[0].width*scale:job.width;
  const height=scale?images[0].height*scale:job.height;
  if (width>1920 || height>6144 || width*height>4_000_000) return {error:'OUTPUT_DIMENSIONS'};
  const canvas=createCanvas(width,height);
  const ctx=canvas.getContext('2d');
  if (background!=='transparent') {
    ctx.fillStyle=background;
    ctx.fillRect(0,0,width,height);
  }
  if (backdrop) drawFitted(ctx,byId.get(backdrop),0,0,width,height,'cover');
  images.forEach((image,index)=>{
    const start=Math.round(index*height/images.length);
    const end=Math.round((index+1)*height/images.length);
    drawFitted(ctx,image,0,start,width,end-start,fit);
  });
  const aiGenerated=sources.some(source=>source.generated);
  if (aiGenerated) drawAiBadge(ctx,width,height);
  const bytes=canvas.toBuffer(mediaType,aiGenerated?metadata:undefined);
  if (bytes.length>10*1024*1024) return {error:'OUTPUT_TOO_LARGE'};
  return {bytes,aiGenerated,width,height};
}

const results=[];
for (const item of workerData) results.push(await render(item));
parentPort.postMessage(results);
