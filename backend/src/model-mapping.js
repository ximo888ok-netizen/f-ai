import { invalid as invalidInput } from './http.js';
import { GeneratedFile } from './model-file.js';
import { mediaUrl, PendingModelJob, ProviderError } from './model-http.js';

const invalid = () => { throw new Error('Invalid json-http model mapping'); };
const field = path => typeof path === 'string' && path.length <= 200 &&
  path.split('.').every(key => /^[A-Za-z0-9_-]+$/.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key));

function read(value, path) {
  for (const key of path.split('.')) {
    if (value == null || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

function relativePath(path, poll) {
  if (typeof path !== 'string' || path.length > 512) invalid();
  if (poll && !path.includes('{id}')) invalid();
  const plain = poll ? path.replaceAll('{id}', 'job') : path;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_./?=&:-]*$/.test(plain) || plain.includes('..') || plain.includes(':') || plain.includes('//')) invalid();
}

function template(value, context, depth = 0) {
  if (depth > 12) invalid();
  if (Array.isArray(value)) return value.map(item => template(item, context, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  if (Object.hasOwn(value, '$from')) {
    const path = value.$from;
    if (Object.keys(value).length !== 1 || !field(path) || !['model', 'prompt', 'parameters', 'assets', 'firstImage'].includes(path.split('.')[0])) invalid();
    return read(context, path);
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (!field(key)) invalid();
    return [key, template(child, context, depth + 1)];
  }));
}

function inputPaths(node, paths = new Set()) {
  if (node && typeof node === 'object') {
    if (Object.hasOwn(node, '$from')) paths.add(node.$from);
    else Object.values(node).forEach(child => inputPaths(child, paths));
  }
  return paths;
}

export function validateMappedMedia(mapping, params) {
  const paths = inputPaths(mapping.body);
  if (paths.has('prompt') && !params.prompt?.trim()) throw invalidInput('This model requires a prompt');
  const assets = params.assetIds?.length ?? 0;
  const usesAssets = [...paths].some(path => path === 'assets' || path.startsWith('assets.'));
  if (assets && !usesAssets && !(paths.has('firstImage') && assets === 1)) throw invalidInput('Asset input is not mapped for this model');
  if (!assets && paths.has('firstImage')) throw invalidInput('Select a first-frame image');
  if (paths.has('parameters')) return;
  for (const key of Object.keys(params)) {
    if (key === 'assetIds' || (key === 'prompt' && paths.has('prompt')) || paths.has('parameters.' + key)) continue;
    if (key === 'options' && Object.keys(params.options).every(option => paths.has('parameters.options.' + option))) continue;
    throw invalidInput('Parameter is not mapped for this model: ' + key);
  }
}

export function validateMapping(mapping) {
  if (!mapping || !['text', 'image', 'video'].includes(mapping.kind) || !mapping.body || typeof mapping.body !== 'object' || Array.isArray(mapping.body)) invalid();
  relativePath(mapping.createPath, false);
  template(mapping.body, {});
  if (!field(mapping.outputPath)) invalid();
  const formats = { text: ['text'], image: ['url', 'png-base64', 'jpeg-base64'], video: ['url'] };
  if (!formats[mapping.kind].includes(mapping.outputFormat)) invalid();
  if (mapping.poll !== undefined) {
    const poll = mapping.poll;
    if (!poll || !field(poll.jobIdPath) || !field(poll.statusPath)) invalid();
    relativePath(poll.path, true);
    if (poll.resultPath !== undefined) relativePath(poll.resultPath, true);
    for (const values of [poll.pending, poll.success]) {
      if (!Array.isArray(values) || !values.length || values.some(item => typeof item !== 'string' || !item)) invalid();
    }
    if (poll.pending.some(item => poll.success.includes(item))) invalid();
  }
  if (mapping.authHeader && !/^(authorization|api-key|x-api-key|x-goog-api-key|x-access-token)$/i.test(mapping.authHeader)) invalid();
  if (mapping.authScheme !== undefined && !['Bearer', 'Key', 'Token', ''].includes(mapping.authScheme)) invalid();
}

function output(route, data) {
  const { kind, outputFormat, outputPath } = route.mapping;
  const value = read(data, outputPath);
  if (outputFormat === 'url') return { type: kind, modelId: route.id, url: mediaUrl(value) };
  if (outputFormat !== 'text') return GeneratedFile.image(value, outputFormat === 'png-base64' ? 'image/png' : 'image/jpeg');
  if (typeof value !== 'string' || !value.trim() || value.includes('\u0000')) throw new ProviderError('INVALID_PROVIDER_RESULT');
  return { type: 'text', modelId: route.id, text: value };
}

export async function runMapped(route, payload, prompt, call) {
  const { mapping } = route;
  const first = payload.assets[0];
  const context = { model: route.model, parameters: payload.parameters, assets: payload.assets, prompt,
    firstImage: first && 'data:' + first.mediaType + ';base64,' + first.dataBase64 };
  const data = await call(mapping.createPath, template(mapping.body, context));
  return mapping.poll ? new PendingModelJob(read(data, mapping.poll.jobIdPath)) : output(route, data);
}

export async function pollMapped(route, id, call) {
  const poll = route.mapping.poll;
  const data = await call(poll.path.replaceAll('{id}', encodeURIComponent(id)));
  const status = read(data, poll.statusPath);
  if (poll.pending.includes(status)) return new PendingModelJob(id);
  if (!poll.success.includes(status)) throw new ProviderError('MODEL_JOB_FAILED');
  const result = poll.resultPath ? await call(poll.resultPath.replaceAll('{id}', encodeURIComponent(id))) : data;
  return output(route, result);
}
