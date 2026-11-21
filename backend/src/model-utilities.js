import { invalid } from './http.js';
import { GeneratedFile } from './model-file.js';
import { ProviderError } from './model-http.js';

export const utilityCapabilities = {
  embedding: ['model.embed'], rerank: ['model.rerank'],
  transcription: ['model.transcribe'], speech: ['model.speech'],
};
const transcriptionExtensions = { 'audio/mpeg':'mp3', 'video/mp4':'mp4', 'audio/mp4':'m4a', 'audio/webm':'webm' };

export async function runUtility(route, payload, call) {
  const { parameters, assets } = payload;
  const { model, id: modelId } = route;
  if (route.kind === 'embedding') {
    const data = await call('embeddings', { model, input: parameters.input, encoding_format: 'float' });
    const entries = data?.data;
    if (!Array.isArray(entries) || entries.length !== parameters.input.length) throw new ProviderError('INVALID_MODEL_EMBEDDINGS');
    const vectors = Array(entries.length);
    for (const entry of entries) {
      const { index, embedding } = entry ?? {};
      if (!Number.isInteger(index) || index < 0 || index >= vectors.length || vectors[index] || !Array.isArray(embedding) ||
        !embedding.length || embedding.some(value => !Number.isFinite(value))) throw new ProviderError('INVALID_MODEL_EMBEDDINGS');
      vectors[index] = embedding;
    }
    if (vectors.some(vector => vector.length !== vectors[0].length)) throw new ProviderError('INVALID_MODEL_EMBEDDINGS');
    return { type: 'embedding', vectors, modelId };
  }
  if (route.kind === 'rerank') {
    const { query, documents, topN = documents.length } = parameters;
    const data = await call('rerank', { model, query, documents, top_n: topN });
    const seen = new Set();
    if (!Array.isArray(data?.results) || data.results.length !== topN) throw new ProviderError('INVALID_MODEL_RANKING');
    const results = data.results.map(item => {
      const { index, relevance_score: score } = item ?? {};
      if (!Number.isInteger(index) || index < 0 || index >= documents.length || !Number.isFinite(score) || seen.has(index)) throw new ProviderError('INVALID_MODEL_RANKING');
      seen.add(index);
      return { index, score };
    });
    return { type: 'rerank', results, modelId };
  }
  if (route.kind === 'speech') {
    const bytes = await call('audio/speech', { model, input: parameters.input, voice: parameters.voice, response_format: 'mp3' }, {}, true);
    return new GeneratedFile(bytes, 'audio/mpeg');
  }
  const file = assets[0];
  const extension = transcriptionExtensions[file?.mediaType];
  if (!extension) throw invalid('Transcription requires one MP3, MP4, M4A, or WebM asset');
  const form = new FormData();
  form.set('file', new Blob([Buffer.from(file.dataBase64, 'base64')], { type: file.mediaType }), 'input.' + extension);
  form.set('model', model);
  if (parameters.language) form.set('language', parameters.language);
  const data = await call('audio/transcriptions', form);
  if (typeof data?.text !== 'string' || data.text.includes('\u0000')) throw new ProviderError('INVALID_PROVIDER_RESULT');
  return { type: 'text', text: data.text, modelId };
}
