import { loadImage } from '@napi-rs/canvas';
import { imageSize } from 'image-size';

export async function decodeImage(bytes) {
  const data=Buffer.from(bytes);
  const source=imageSize(data);
  if (!['jpg','png'].includes(source.type) || !source.width || !source.height || source.width*source.height>16_000_000) {
    throw new Error('Unsupported source image');
  }
  const image=await loadImage(data);
  if (!image.width || !image.height || image.width*image.height>16_000_000) throw new Error('Unsupported decoded image size');
  return image;
}

export function drawFitted(ctx,image,x,y,width,height,fit='contain') {
  const scale=(fit==='cover'?Math.max:Math.min)(width/image.width,height/image.height);
  const w=image.width*scale;
  const h=image.height*scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x,y,width,height);
  ctx.clip();
  ctx.drawImage(image,x+(width-w)/2,y+(height-h)/2,w,h);
  ctx.restore();
}
