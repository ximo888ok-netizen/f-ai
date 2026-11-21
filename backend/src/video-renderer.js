import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { createCanvas } from '@napi-rs/canvas';
import { drawAiBadge, metadata } from './ai-export-mark.js';
import { ApiError } from './http.js';
import { decodeImage, drawFitted } from './raster.js';

const exec=promisify(execFile);
const maxInputBytes=10*1024*1024;
const maxOutputBytes=64*1024*1024;
const maxSeconds=60;
const maxPixels=1920*1080;
const protocols=['-protocol_whitelist','file,pipe'];
const mp4Input=[...protocols,'-f','mov','-enable_drefs','0'];
const base=['-nostdin','-hide_banner','-loglevel','error','-xerror'];
const encoders={libx264:['-preset','veryfast','-crf','23'],libopenh264:['-b:v','4M','-maxrate','5M','-bufsize','10M']};
export const videoProfiles={'16:9':[1280,720],'9:16':[720,1280],'1:1':[720,720]};
export const videoFormats={mp4:'video/mp4',png:'image/png',jpg:'image/jpeg',mp3:'audio/mpeg'};
const invalidVideo=()=>new ApiError(422,'VIDEO_EXPORT_INVALID',
  'Use readable media within the duration, frame size and file size limits');
const even=value=>Math.ceil(value/2)*2;

async function run(tool,args,timeout) {
  try {
    return (await exec(tool,args,{windowsHide:true,timeout,maxBuffer:256*1024})).stdout;
  } catch (error) {
    if (error.killed) throw new ApiError(503,'VIDEO_EXPORT_TIMEOUT','Video processing exceeded the time limit');
    if (typeof error.code!=='number') throw new ApiError(503,'VIDEO_EXPORT_UNAVAILABLE','The video tool could not start');
    throw invalidVideo();
  }
}

async function inspect(ffprobe,file) {
  return JSON.parse(await run(ffprobe,[
    '-v','error',...mp4Input,'-i',file,
    '-show_entries','stream=codec_type,width,height,r_frame_rate,duration,sample_aspect_ratio:stream_disposition=attached_pic:stream_side_data=rotation:format=duration:format_tags=fai_ai_generated',
    '-of','json',
  ],10000));
}

function geometry(inspection) {
  const video=inspection.streams?.find(stream=>stream.codec_type==='video' && !stream.disposition?.attached_pic);
  if (!video) throw invalidVideo();
  const duration=Number(inspection.format?.duration);
  const [frames,seconds]=String(video.r_frame_rate).split('/').map(Number);
  const fps=frames/seconds;
  const rotation=(video.side_data_list?.find(data=>Number.isFinite(data.rotation))?.rotation ?? 0)%360;
  if (rotation%90!==0 || !(duration>0 && duration<=maxSeconds) || !(fps>0 && fps<=60)
    || !(video.width>=32 && video.height>=32 && video.width<=1920 && video.height<=1920)
    || video.width*video.height>maxPixels) throw invalidVideo();
  const [numerator,denominator]=String(video.sample_aspect_ratio).split(':').map(Number);
  const ratio=numerator/denominator;
  const sar=ratio>0 && Number.isFinite(ratio)?ratio:1;
  const rotated=Math.abs(rotation)===90 || Math.abs(rotation)===270;
  return {width:rotated?video.height:video.width,height:rotated?video.width:video.height,sar:rotated?1/sar:sar,duration,fps,
    videoDuration:Number(video.duration),audio:inspection.streams.find(stream=>stream.codec_type==='audio')};
}

function transform(video,ratio,still) {
  if (ratio==='original' && (!still || video.sar===1)) {
    return {width:even(video.width),height:even(video.height),filter:'pad=ceil(iw/2)*2:ceil(ih/2)*2'};
  }
  const displayWidth=video.width*video.sar;
  const size=videoProfiles[ratio] ?? [even(video.width),even(video.height)];
  const [width,height]=size;
  const scale=Math.min(width/displayWidth,height/video.height);
  const fittedWidth=Math.max(2,Math.floor(displayWidth*scale/2)*2);
  const fittedHeight=Math.max(2,Math.floor(video.height*scale/2)*2);
  return {width,height,filter:`scale=${fittedWidth}:${fittedHeight},setsar=1,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black`};
}

const tagArgs=['-metadata','description='+metadata.description,'-metadata','fai_ai_generated=true',
  '-metadata','fai_software='+metadata.software];
const sameDuration=(before,after,tolerance)=>!Number.isFinite(Number(before)) || Math.abs(Number(after)-Number(before))<=tolerance;

async function outputBytes(file) {
  let info;
  try { info=await stat(file); } catch (error) { if (error.code==='ENOENT') throw invalidVideo(); throw error; }
  if (!info.size || info.size>=maxOutputBytes) throw invalidVideo();
  return readFile(file);
}

export function createVideoDelivery({
  ffmpeg=process.env.VIDEO_FFMPEG_PATH,ffprobe=process.env.VIDEO_FFPROBE_PATH,
  encoder=process.env.VIDEO_EXPORT_ENCODER ?? 'libx264',
}={}) {
  if (!ffmpeg && !ffprobe) return null;
  if (!ffmpeg || !ffprobe || !isAbsolute(ffmpeg) || !isAbsolute(ffprobe)) {
    throw new Error('VIDEO_FFMPEG_PATH and VIDEO_FFPROBE_PATH must both be absolute executable paths');
  }
  if (!Object.hasOwn(encoders,encoder)) throw new Error('Unsupported VIDEO_EXPORT_ENCODER');
  const videoEncoding=['-c:v',encoder,...encoders[encoder],'-threads','2','-pix_fmt','yuv420p'];
  const audioEncoding=['-c:a','aac','-b:a','128k'];
  const mux=mark=>['-map_metadata','-1','-map_chapters','-1',...(mark?tagArgs:[]),'-movflags','+faststart+use_metadata_tags',
    '-fs',String(maxOutputBytes),'-f','mp4'];
  let active=0;

  async function withFiles(job) {
    if (active>=2) throw new ApiError(503,'VIDEO_EXPORT_BUSY','The video renderer is busy. Retry in a moment');
    active++;
    let directory;
    const files=new Set();
    try {
      directory=await mkdtemp(join(tmpdir(),'fai-video-'));
      return await job(name=>{const file=join(directory,name);files.add(file);return file;});
    } finally {
      try {
        await Promise.all([...files].map(file=>unlink(file).catch(error=>{if (error.code!=='ENOENT') throw error;})));
        if (directory) await rmdir(directory);
      } finally {active--;}
    }
  }

  async function verify(file,{width,height,duration,tolerance,videoDuration,audioDuration,hasAudio,mark}) {
    const output=await inspect(ffprobe,file);
    const video=output.streams?.find(stream=>stream.codec_type==='video');
    const audio=output.streams?.find(stream=>stream.codec_type==='audio');
    if (!sameDuration(duration,output.format?.duration,tolerance) || !sameDuration(videoDuration,video?.duration,tolerance)
      || !sameDuration(audioDuration,audio?.duration,tolerance) || width!==video?.width || height!==video?.height
      || hasAudio!==Boolean(audio) || mark!==(output.format?.tags?.fai_ai_generated==='true')) throw invalidVideo();
    return outputBytes(file);
  }

  async function convert(bytes,{format='mp4',ratio='original',frameMs=0,keepAudio=true,mark=false}={}) {
    if (bytes.byteLength>maxInputBytes) throw invalidVideo();
    return withFiles(async file=>{
      const input=file('input.mp4');
      await writeFile(input,bytes);
      const inputInfo=await inspect(ffprobe,input);
      const video=geometry(inputInfo);
      mark ||= inputInfo.format?.tags?.fai_ai_generated==='true';
      const inputArgs=[...mp4Input,'-threads','2','-max_pixels',String(maxPixels),'-i',input];
      if (format==='mp3') {
        if (!video.audio) throw new ApiError(422,'VIDEO_NO_AUDIO','This video has no audio track to export');
        const output=file('track.mp3');
        await run(ffmpeg,[...base,...inputArgs,'-map','0:a:0','-map_metadata','-1','-map_chapters','-1',
          '-c:a','libmp3lame','-b:a','128k',...(mark?['-metadata','comment=Derived from AI-generated video']:[]),
          '-t',String(maxSeconds+1),'-fs',String(maxOutputBytes),'-f','mp3',output],90000);
        return outputBytes(output);
      }

      const still=format!=='mp4';
      const target=transform(video,ratio,still);
      if (still) {
        if (frameMs/1000>=(video.videoDuration || video.duration)) throw new ApiError(422,'VIDEO_FRAME_OUT_OF_RANGE','Choose a frame within the video');
        const output=file('frame.png');
        await run(ffmpeg,[...base,'-ss',String(frameMs/1000),...inputArgs,'-map','0:V:0','-vf',target.filter,
          '-frames:v','1','-threads','1','-update','1','-f','image2',output],30000);
        const frame=await decodeImage(await outputBytes(output));
        const canvas=createCanvas(frame.width,frame.height);
        const ctx=canvas.getContext('2d');
        ctx.drawImage(frame,0,0);
        if (mark) drawAiBadge(ctx,frame.width,frame.height);
        return canvas.toBuffer(videoFormats[format],mark?metadata:undefined);
      }

      const output=file('delivery.mp4');
      let filter=target.filter;
      let badgeArgs=[];
      const videoMap=['-map','0:V:0','-vf',filter];
      if (mark) {
        const badge=file('badge.png');
        const canvas=createCanvas(target.width,target.height);
        drawAiBadge(canvas.getContext('2d'),target.width,target.height);
        await writeFile(badge,await canvas.encode('png'));
        badgeArgs=[...protocols,'-i',badge];
        filter='[0:V:0]'+filter+'[base];[base][1:v]overlay=eof_action=repeat[marked]';
        videoMap.splice(0,videoMap.length,'-filter_complex_threads','1','-filter_complex',filter,'-map','[marked]');
      }
      const hasAudio=keepAudio && Boolean(video.audio);
      await run(ffmpeg,[...base,...inputArgs,...badgeArgs,...videoMap,
        ...(hasAudio?['-map','0:a:0',...audioEncoding]:['-an']),...videoEncoding,
        '-t',String(maxSeconds+1),...mux(mark),output],90000);
      const duration=hasAudio?video.duration:(video.videoDuration || video.duration);
      return verify(output,{...target,duration,tolerance:Math.max(0.15,1/video.fps),videoDuration:video.videoDuration,
        audioDuration:hasAudio?video.audio.duration:undefined,hasAudio,mark});
    });
  }

  async function storyboard({shots,ratio,audio,mark}) {
    const [width,height]=videoProfiles[ratio];
    const duration=shots.reduce((sum,shot)=>sum+shot.durationMs,0)/1000;
    return withFiles(async file=>{
      const manifest=file('shots.txt');
      const list=[];
      for (const [index,shot] of shots.entries()) {
        let image;
        try { image=await decodeImage(shot.bytes); } catch { throw invalidVideo(); }
        const canvas=createCanvas(width,height);
        const ctx=canvas.getContext('2d');
        ctx.fillStyle='#111827';
        ctx.fillRect(0,0,width,height);
        drawFitted(ctx,image,0,0,width,height);
        if (shot.caption) {
          ctx.fillStyle='#111827';
          ctx.fillRect(0,0,width,54);
          ctx.font='24px "Microsoft YaHei", "Noto Sans CJK SC", sans-serif';
          ctx.fillStyle='#ffffff';
          ctx.fillText(shot.caption,20,36,width-40);
        }
        if (mark) drawAiBadge(ctx,width,height);
        const name='shot-'+index+'.png';
        await writeFile(file(name),await canvas.encode('png'));
        list.push('file '+name,'duration '+shot.durationMs/1000);
      }
      list.push('file shot-'+(shots.length-1)+'.png');
      await writeFile(manifest,list.join('\n')+'\n');
      let audioInput=[];
      if (audio) {
        const track=file('audio.mp3');
        await writeFile(track,audio);
        audioInput=[...protocols,'-f','mp3','-i',track];
      }
      const output=file('storyboard.mp4');
      await run(ffmpeg,[...base,...protocols,'-f','concat','-safe','1','-i',manifest,...audioInput,
        '-map','0:V:0',...(audio?['-map','1:a:0','-af','apad',...audioEncoding]:['-an']),
        '-vf','fps=25,tpad=stop_mode=clone:stop_duration='+duration,
        ...videoEncoding,'-t',String(duration),...mux(mark),output],90000);
      return verify(output,{width,height,duration,tolerance:0.15,videoDuration:duration,audioDuration:audio?duration:undefined,
        hasAudio:Boolean(audio),mark});
    });
  }

  return Object.assign(bytes=>convert(bytes,{mark:true}),{process:convert,storyboard});
}
