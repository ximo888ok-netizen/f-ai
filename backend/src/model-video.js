import { mediaUrl, PendingModelJob, ProviderError } from './model-http.js';

function success(route, url) {
  return { type: 'video', url: mediaUrl(url), modelId: route.id };
}

function minimaxStatus(data) {
  if (data?.base_resp?.status_code !== 0) throw new ProviderError('PROVIDER_REJECTED');
}

export async function startVideo(route, payload, call) {
  const { prompt, ratio, options } = payload.parameters;
  const duration = options?.durationSeconds;
  const asset = payload.assets[0];
  const image = asset && 'data:' + asset.mediaType + ';base64,' + asset.dataBase64;
  const model = route.model;
  if(route.protocol==='wan-frames') {
    const last=payload.assets[1];
    const data=await call('services/aigc/image2video/video-synthesis',{model,input:{prompt,first_frame_url:image,
      last_frame_url:'data:'+last.mediaType+';base64,'+last.dataBase64}},{'X-DashScope-Async':'enable'});
    return new PendingModelJob(data?.output?.task_id);
  }
  if (route.protocol === 'runway-video') {
    const sizes = { '16:9': '1280:720', '9:16': '720:1280', '1:1': '960:960' };
    const data = await call(image ? 'image_to_video' : 'text_to_video', {
      model, promptText: prompt, promptImage: image, ratio: sizes[ratio ?? '16:9'], duration: duration ?? 5,
    });
    return new PendingModelJob(data?.id);
  }
  if (route.protocol === 'ark-video') {
    const content = [{ type: 'text', text: prompt }];
    for(const [i,ref] of payload.assets.entries()) content.push({type:'image_url',
      image_url:{url:'data:'+ref.mediaType+';base64,'+ref.dataBase64},
      role:payload.parameters.frameMode==='references'?'reference_image':i===0?'first_frame':'last_frame'});
    const data = await call('contents/generations/tasks', { model, content, ratio, duration });
    return new PendingModelJob(data?.id);
  }
  if (route.protocol === 'wan-video') {
    const data = await call('services/aigc/video-generation/video-synthesis', { model, input: { prompt }, parameters: { ratio, duration } }, { 'X-DashScope-Async': 'enable' });
    return new PendingModelJob(data?.output?.task_id);
  }
  const data = await call('video_generation', { model, prompt, duration, first_frame_image: image });
  minimaxStatus(data);
  return new PendingModelJob(data.task_id);
}

export async function pollVideo(route, id, call) {
  if (route.protocol === 'runway-video') {
    const data = await call('tasks/' + encodeURIComponent(id));
    if (['PENDING', 'THROTTLED', 'RUNNING'].includes(data?.status)) return new PendingModelJob(id);
    if (data?.status === 'SUCCEEDED') return success(route, data.output?.[0]);
  } else if (route.protocol === 'ark-video') {
    const data = await call('contents/generations/tasks/' + encodeURIComponent(id));
    if (['queued', 'running'].includes(data?.status)) return new PendingModelJob(id);
    if (data?.status === 'succeeded') return success(route, data.content?.video_url);
  } else if (route.protocol === 'wan-video' || route.protocol === 'wan-frames') {
    const data = await call('tasks/' + encodeURIComponent(id));
    const output = data?.output;
    if (['PENDING', 'RUNNING'].includes(output?.task_status)) return new PendingModelJob(id);
    if (output?.task_status === 'SUCCEEDED') return success(route, output.video_url);
  } else {
    const data = await call('query/video_generation?task_id=' + encodeURIComponent(id));
    minimaxStatus(data);
    if (['Preparing', 'Queueing', 'Processing'].includes(data.status)) return new PendingModelJob(id);
    if (data.status === 'Success') {
      const fileId = new PendingModelJob(data.file_id).id;
      const file = await call('files/retrieve?file_id=' + encodeURIComponent(fileId));
      minimaxStatus(file);
      return success(route, file.file?.download_url);
    }
  }
  throw new ProviderError('VIDEO_GENERATION_FAILED');
}
