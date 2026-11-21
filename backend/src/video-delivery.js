import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { metadata, drawAiBadge } from './ai-export-mark.js';
import { ApiError, notFound, object, route, uuid } from './http.js';
import { row } from './db.js';

const exec = promisify(execFile);
const maxInputBytes = 10 * 1024 * 1024;
const maxOutputBytes = 64 * 1024 * 1024;
const limits = { maxDurationSeconds:60, maxWidth:1920, maxHeight:1920, maxPixels:1920*1080, maxFps:60 };
const inputOptions = ['-protocol_whitelist', 'file,pipe', '-f', 'mov', '-enable_drefs', '0'];
const mp4 = 'video/mp4';
const invalidVideo = () => new ApiError(422,'VIDEO_EXPORT_INVALID',
  'Use a readable MP4 of up to 60 seconds, 1920 pixels per side, 1080p total pixels and 60 fps');

async function run(tool,args,timeout) {
  try {
    const {stdout}=await exec(tool,args,{windowsHide:true,timeout,maxBuffer:256*1024});
    return stdout;
  } catch (error) {
    if (error.killed) throw new ApiError(503,'VIDEO_EXPORT_TIMEOUT','Video processing exceeded the time limit');
    if (typeof error.code !== 'number') throw new ApiError(503,'VIDEO_EXPORT_UNAVAILABLE','The video tool could not start');
    throw invalidVideo();
  }
}

async function inspect(ffprobe,file) {
  const result=await run(ffprobe,[
    '-v','error',...inputOptions,'-i',file,
    '-show_entries','stream=codec_type,width,height,r_frame_rate,duration:stream_disposition=attached_pic:stream_side_data=rotation:format=duration:format_tags=fai_ai_generated',
    '-of','json',
  ],10000);
  return JSON.parse(result);
}

function geometry(inspection) {
  const video=inspection.streams?.find(stream=>stream.codec_type==='video' && !stream.disposition?.attached_pic);
  if (!video) throw invalidVideo();
  const duration=Number(inspection.format?.duration);
  const [frames,seconds]=String(video.r_frame_rate).split('/').map(Number);
  const fps=frames/seconds;
  const rotation=(video.side_data_list?.find(data=>Number.isFinite(data.rotation))?.rotation ?? 0)%360;
  if (rotation%90 !== 0 || !(duration>0 && duration<=limits.maxDurationSeconds) || !(fps>0 && fps<=limits.maxFps)
      || !(video.width>=32 && video.height>=32 && video.width<=limits.maxWidth && video.height<=limits.maxHeight)
      || video.width*video.height>limits.maxPixels) throw invalidVideo();
  const rotated=Math.abs(rotation)===90 || Math.abs(rotation)===270;
  return {width:rotated?video.height:video.width,height:rotated?video.width:video.height,duration,fps,
    videoDuration:Number(video.duration),audio:inspection.streams.find(stream=>stream.codec_type==='audio')};
}

export function createVideoDelivery({
  ffmpeg=process.env.VIDEO_FFMPEG_PATH,ffprobe=process.env.VIDEO_FFPROBE_PATH,
  encoder=process.env.VIDEO_EXPORT_ENCODER ?? 'libx264',
}={}) {
  if (!ffmpeg && !ffprobe) return null;
  if (!ffmpeg || !ffprobe || !isAbsolute(ffmpeg) || !isAbsolute(ffprobe)) {
    throw new Error('VIDEO_FFMPEG_PATH and VIDEO_FFPROBE_PATH must both be absolute executable paths');
  }
  const encoders={
    libx264:['-preset','veryfast','-crf','23'],
    libopenh264:['-b:v','4M','-maxrate','5M','-bufsize','10M'],
  };
  if (!Object.hasOwn(encoders,encoder)) throw new Error('Unsupported VIDEO_EXPORT_ENCODER');
  let active=0;

  return async function render(bytes) {
    if (bytes.byteLength>maxInputBytes) throw invalidVideo();
    if (active>=2) throw new ApiError(503,'VIDEO_EXPORT_BUSY','The video renderer is busy. Retry in a moment');
    active++;
    let temp;
    let files=[];
    try {
      temp=await mkdtemp(join(tmpdir(),'fai-video-'));
      const [input,badge,output]=files=['input.mp4','badge.png','delivery.mp4'].map(file=>join(temp,file));
      await writeFile(input,bytes);
      const video=geometry(await inspect(ffprobe,input));
      const width=Math.ceil(video.width/2)*2;
      const height=Math.ceil(video.height/2)*2;
      const canvas=createCanvas(width,height);
      drawAiBadge(canvas.getContext('2d'),width,height);
      await writeFile(badge,await canvas.encode('png'));
      await run(ffmpeg,[
        '-nostdin','-hide_banner','-loglevel','error','-xerror','-filter_complex_threads','1',
        ...inputOptions,'-threads','2','-max_pixels',String(limits.maxPixels),'-i',input,
        '-protocol_whitelist','file,pipe','-i',badge,
        '-filter_complex','[0:V:0]pad=ceil(iw/2)*2:ceil(ih/2)*2[base];[base][1:v]overlay=eof_action=repeat[marked]',
        '-map','[marked]','-map','0:a:0?','-map_metadata','-1','-map_chapters','-1',
        '-c:v',encoder,...encoders[encoder],'-threads','2','-pix_fmt','yuv420p',
        '-c:a','aac','-b:a','128k','-t',String(limits.maxDurationSeconds+1),'-fs',String(maxOutputBytes),
        '-metadata','description='+metadata.description,'-metadata','fai_ai_generated=true','-metadata','fai_software='+metadata.software,
        '-movflags','+faststart+use_metadata_tags','-f','mp4',output,
      ],90000);
      const inspection=await inspect(ffprobe,output);
      const duration=Number(inspection.format?.duration);
      const videoStream=inspection.streams?.find(stream=>stream.codec_type==='video');
      const audioStream=inspection.streams?.find(stream=>stream.codec_type==='audio');
      const tolerance=Math.max(0.15,1/video.fps);
      const sameDuration=(before,after)=>!Number.isFinite(Number(before)) || Math.abs(Number(after)-Number(before))<=tolerance;
      if ((await stat(output)).size>=maxOutputBytes || !sameDuration(video.duration,duration)
          || !sameDuration(video.videoDuration,videoStream?.duration) || !sameDuration(video.audio?.duration,audioStream?.duration)
          || videoStream?.width!==width || videoStream?.height!==height || inspection.format?.tags?.fai_ai_generated!=='true'
          || Boolean(video.audio)!==Boolean(audioStream)) throw invalidVideo();
      return await readFile(output);
    } finally {
      try {
        await Promise.all(files.map(file=>unlink(file).catch(error=>{if (error.code!=='ENOENT') throw error;})));
        if (temp) await rmdir(temp);
      } finally {active--;}
    }
  };
}

export async function sendVideoDelivery(render,asset,id,reply) {
  if (!render) throw new ApiError(503,'VIDEO_EXPORT_UNAVAILABLE','Video export is not configured on this server');
  if (asset.media_type!==mp4) throw new ApiError(422,'VIDEO_EXPORT_MP4_REQUIRED','Select an MP4 asset');
  const bytes=await render(asset.data);
  return reply.header('content-disposition','attachment; filename="ai-delivery-'+id+'.mp4"').type(mp4).send(bytes);
}

export function registerVideoDelivery(app,db,render) {
  const tags=['Video delivery'];
  route(app,'GET','/v1/video-export/status',{tags,summary:'Check if marked MP4 export is enabled',
    response:{200:object({available:{type:'boolean'}})}},async ()=>({available:Boolean(render)}));
  route(app,'POST','/v1/assets/:id/video-export',{tags,params:object({id:uuid}),
    summary:'Export an owned MP4 explicitly declared to be AI-generated',produces:[mp4],
    body:object({aiGenerated:{const:true}})},async (request,reply)=>{
    const {workspaceId,accountId}=request.context;
    const {id}=request.params;
    const asset=await row(db,'SELECT media_type,data FROM assets WHERE workspace_id=$1 AND account_id=$2 AND id=$3',
      [workspaceId,accountId,id]);
    if (!asset) throw notFound('Asset');
    return sendVideoDelivery(render,asset,id,reply);
  });
}
