import { parentPort, workerData } from 'node:worker_threads';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { imageSize } from 'image-size';
import { writePsdBuffer } from 'ag-psd';
import { drawAiBadge, metadata, provenanceXmp } from './ai-export-mark.js';

const fonts = {
  sans: { canvas:'Arial, "Liberation Sans", sans-serif', psd:'ArialMT' },
  chinese: { canvas:'"Noto Sans CJK SC", "Microsoft YaHei", SimHei, sans-serif', psd:'NotoSansCJKsc-Regular' },
};
const color = hex => ({ r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16) });

async function decodeImage(bytes) {
  const data = Buffer.from(bytes);
  const source = imageSize(data);
  if (!['jpg','png'].includes(source.type) || !source.width || !source.height || source.width*source.height>16_000_000) {
    throw new Error('Unsupported source image');
  }
  const image = await loadImage(data);
  if (!image.width || !image.height || image.width*image.height>16_000_000) throw new Error('Unsupported decoded image size');
  return image;
}

async function drawSource(context, bytes, width, height, fit) {
  const image=await decodeImage(bytes);
  const scale = fit(width/image.width,height/image.height);
  const w = image.width*scale;
  const h = image.height*scale;
  context.drawImage(image,(width-w)/2,(height-h)/2,w,h);
}

const pixels = canvas => canvas.getContext('2d').getImageData(0,0,canvas.width,canvas.height);

async function render({layout,subject,background,format,aiGenerated}) {
  const {width,height,backgroundColor,placement,caption} = layout;
  const {x,y,width:subjectWidth,height:subjectHeight} = placement;
  const font = fonts[caption.font];
  const backgroundLayer = createCanvas(width,height);
  const bg = backgroundLayer.getContext('2d');
  bg.fillStyle=backgroundColor;
  bg.fillRect(0,0,width,height);
  if (background) await drawSource(bg,background,width,height,Math.max);

  const subjectLayer = createCanvas(subjectWidth,subjectHeight);
  await drawSource(subjectLayer.getContext('2d'),subject,subjectWidth,subjectHeight,Math.min);

  const captionLayer = createCanvas(width,height);
  const text = captionLayer.getContext('2d');
  text.font=caption.size+'px '+font.canvas;
  text.fillStyle=caption.color;
  text.textBaseline='alphabetic';
  text.fillText(caption.text,caption.x,caption.y);

  const combined=createCanvas(width,height);
  const ctx=combined.getContext('2d');
  ctx.drawImage(backgroundLayer,0,0);
  ctx.drawImage(subjectLayer,x,y);
  ctx.drawImage(captionLayer,0,0);
  const marker=aiGenerated?createCanvas(width,height):null;
  if (marker) {
    drawAiBadge(marker.getContext('2d'),width,height);
    ctx.drawImage(marker,0,0);
  }
  if (format==='png') return marker?combined.toBuffer('image/png',metadata):combined.toBuffer('image/png');

  return writePsdBuffer({width,height,imageData:pixels(combined),
    ...(marker && {imageResources:{xmpMetadata:provenanceXmp}}),children:[
    {name:'Background',left:0,top:0,imageData:pixels(backgroundLayer)},
    {name:'Subject',left:x,top:y,imageData:pixels(subjectLayer)},
    {name:'Caption',left:0,top:0,imageData:pixels(captionLayer),
      text:{text:caption.text,orientation:'horizontal',transform:[1,0,0,1,caption.x,caption.y],
        style:{font:{name:font.psd},fontSize:caption.size,fillColor:color(caption.color)}}},
    ...(marker?[{name:'AI generated',left:0,top:0,imageData:pixels(marker)}]:[]),
  ]});
}

async function renderMarkedSource({subject,mime}) {
  const image=await decodeImage(subject);
  if (image.width<64 || image.height<32) throw new Error('AI export is too small to mark');
  const canvas=createCanvas(image.width,image.height);
  const context=canvas.getContext('2d');
  context.drawImage(image,0,0);
  drawAiBadge(context,image.width,image.height);
  return canvas.toBuffer(mime,metadata);
}

try {
  const bytes = await (workerData.format==='marked-source'?renderMarkedSource(workerData):render(workerData));
  parentPort.postMessage({bytes});
} catch {
  parentPort.postMessage({error:'PSD_SOURCE_INVALID'});
}
