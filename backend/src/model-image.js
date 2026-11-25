import { mediaUrl, ProviderError } from './model-http.js';
import { GeneratedFile } from './model-file.js';

export const supportsImageQuality = config => config.protocol === 'openai-images' &&
  /^(?:gpt-image-|chatgpt-image-latest$)/.test(config.model);

export async function generateImage(route, payload, call) {
  const { prompt, ratio, format } = payload.parameters;
  const expected = format ? { png: 'image/png', jpg: 'image/jpeg' }[format] : undefined;

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
