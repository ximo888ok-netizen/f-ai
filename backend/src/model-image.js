import { mediaUrl, ProviderError } from './model-http.js';
import { GeneratedFile } from './model-file.js';

export const supportsImageQuality = config => config.protocol === 'openai-images' &&
  /^(?:gpt-image-|chatgpt-image-latest$)/.test(config.model);

const imageSizes = { '1:1': '1024x1024', '4:3': '1280x960', '3:4': '960x1280', '16:9': '1280x720', '9:16': '720x1280' };

async function generateJsonImage(route, payload, call) {
  const { prompt, ratio, format } = payload.parameters;
  const images = payload.assets.map(asset => 'data:' + asset.mediaType + ';base64,' + asset.dataBase64);
  const body = { model: route.model, prompt, response_format: 'b64_json' };
  let path = 'images/generations';
  if (route.protocol === 'minimax-h3-image') {
    body.area = '1K';
    if (ratio) body.aspect_ratio = ratio;
    if (images.length) {
      path = 'images/edits';
      body.images = images.map(image_url => ({ image_url }));
    }
  } else {
    if (ratio) body.size = imageSizes[ratio];
    if (images.length) body.image = images.length === 1 ? images[0] : images;
  }
  if (route.protocol !== 'qwen-image') body.output_format = format === 'jpg' ? 'jpeg' : 'png';
  const data = await call(path, body);
  return GeneratedFile.image(data?.data?.[0]?.b64_json, format === 'jpg' ? 'image/jpeg' : 'image/png');
}

export async function generateImage(route, payload, call) {
  const { prompt, ratio, format } = payload.parameters;
  const expected = format ? { png: 'image/png', jpg: 'image/jpeg' }[format] : undefined;

  if (['qwen-image', 'seedream-image', 'minimax-h3-image'].includes(route.protocol)) return generateJsonImage(route, payload, call);

  if (route.protocol === 'openai-images') {
    const body = { model: route.model, prompt, n: 1 };
    if (payload.imageQuality && supportsImageQuality(route)) body.quality = payload.imageQuality;
    if (ratio) body.size = '1024x1024';
    if (format) body.output_format = format === 'jpg' ? 'jpeg' : 'png';
    let data;
    if (payload.assets.length) {
      const form = new FormData();
      for (const [field, value] of Object.entries(body)) form.set(field, String(value));
      for (const [index, asset] of payload.assets.entries()) {
        const ext = asset.mediaType === 'image/png' ? 'png' : 'jpg';
        form.append(payload.assets.length === 1 ? 'image' : 'image[]', new Blob([Buffer.from(asset.dataBase64, 'base64')], { type: asset.mediaType }), 'input-' + index + '.' + ext);
      }
      data = await call('images/edits', form);
    } else {
      data = await call('images/generations', body);
    }
    const entry = data?.data?.[0];
    if (entry?.b64_json) return GeneratedFile.image(entry.b64_json, expected);
    return { type: 'image', url: mediaUrl(entry?.url), modelId: route.id };
  }

  const parts = [{ text: prompt }];
  for (const asset of payload.assets) parts.push({ inlineData: { mimeType: asset.mediaType, data: asset.dataBase64 } });
  const generationConfig = { responseModalities: ['TEXT', 'IMAGE'] };
  if (ratio) generationConfig.imageConfig = { aspectRatio: ratio };
  const data = await call('models/' + encodeURIComponent(route.model) + ':generateContent', {
    contents: [{ role: 'user', parts }], generationConfig,
  });
  const result = data?.candidates?.[0]?.content?.parts?.find(part => !part.thought && part.inlineData?.data)?.inlineData;
  if (expected && result?.mimeType !== expected) throw new ProviderError('MODEL_OUTPUT_FORMAT_MISMATCH');
  return GeneratedFile.image(result?.data, result?.mimeType);
}
