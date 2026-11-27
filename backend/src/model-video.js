import { mediaUrl, PendingModelJob, ProviderError } from './model-http.js';

function success(route, url) {
  return { type: 'video', url: mediaUrl(url), modelId: route.id };
}

function minimaxStatus(data) {
  if (data?.base_resp?.status_code !== 0) throw new ProviderError('PROVIDER_REJECTED');
}

export function videoInputLimits(route) {
  if (route.protocol === 'minimax-h3-video') return { minSeconds: route.model === 'MiniMax-H3-Max' ? 5 : 4, frameRatioFromImage: true };
  if (route.protocol === 'kling-video') return { minSeconds: 3, frameRatioFromImage: true };
  if (route.protocol === 'wan3-video') return { minSeconds: 2, frameRatioFromImage: false };
  if (route.protocol === 'ark-video' && route.model.startsWith('doubao-seedance-2-5-')) return { minSeconds: 4, frameRatioFromImage: false };
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
  if (route.protocol === 'minimax-h3-video') {
    const content = [{ type: 'text', text: prompt }];
    if (image) content.push({ type: 'image_url', image_url: { url: image }, role: 'first_frame' });
    const data = await call('video_generation', { model, content, resolution: '768P', duration: duration ?? 5,
      ratio: image ? 'adaptive' : ratio ?? '16:9' });
    return new PendingModelJob(data?.task_id);
  }
  if (route.protocol === 'kling-video') {
    const contents = [{ type: 'prompt', text: prompt }];
    if (asset) contents.push({ type: 'first_frame', id: 'start', url: asset.dataBase64 });
    const path = (asset ? 'image-to-video/' : 'text-to-video/') + encodeURIComponent(model);
    const data = await call(path, { contents, settings: { duration, aspect_ratio: asset ? undefined : ratio } });
    if (data?.code !== 0) throw new ProviderError('PROVIDER_REJECTED');
    return new PendingModelJob(data.data?.id);
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
  if (route.protocol === 'wan-video' || route.protocol === 'wan3-video') {
    const input = { prompt };
    if (image && route.protocol === 'wan3-video') input.media = [{ type: 'first_frame', url: image }];
    const data = await call('services/aigc/video-generation/video-synthesis', { model, input, parameters: { ratio, duration } }, { 'X-DashScope-Async': 'enable' });
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
  } else if (route.protocol === 'minimax-h3-video') {
    const data = await call('query/video_generation/' + encodeURIComponent(id));
    const task = data?.task;
    if (task?.id !== id) throw new ProviderError('INVALID_PROVIDER_RESULT');
    if (['queued', 'running'].includes(task.status)) return new PendingModelJob(id);
    if (task.status === 'succeeded') return success(route, task.content?.url);
  } else if (route.protocol === 'kling-video') {
    const data = await call('tasks?task_ids=' + encodeURIComponent(id));
    if (data?.code !== 0 || !Array.isArray(data.data)) throw new ProviderError('INVALID_PROVIDER_RESULT');
    const task = data.data.find(item => item?.id === id);
    if (['submitted', 'processing'].includes(task?.status)) return new PendingModelJob(id);
    if (task?.status === 'succeeded') return success(route, task.outputs?.find(output => output.type === 'video')?.url);
  } else if (['wan-video', 'wan3-video', 'wan-frames'].includes(route.protocol)) {
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
