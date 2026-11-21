import { catalog } from './catalog.js';
import { ApiError } from './http.js';
import { GeneratedFile } from './model-file.js';
import { ProviderError } from './model-http.js';

const stages=[
  ['transcriptionModelId','model.transcribe'],
  ['chatModelId','model.chat'],
  ['speechModelId','model.speech'],
];
const unavailable=()=>new ApiError(422,'VOICE_MODEL_UNAVAILABLE','Select a configured model for each voice stage');
const changed=()=>new ProviderError('MODEL_CONFIGURATION_CHANGED');

function modelsFor(providers,parameters) {
  return stages.map(([field,id])=>{
    const model=providers.get('model:'+parameters[field]);
    const capability=catalog.get(id);
    if (!model?.signature || !model.supports(capability)) throw unavailable();
    return {model,capability};
  });
}

function checkedText(result) {
  if (typeof result?.text!=='string' || !result.text.trim() || Array.from(result.text).length>4000 || result.text.includes('\u0000')) {
    throw new ProviderError('VOICE_TEXT_INVALID');
  }
  return result.text.trim();
}

async function invoke(stage,deadline,task,parameters,assets=[]) {
  const timeout=deadline-Date.now();
  if (timeout<=0) throw new ProviderError('VOICE_TURN_TIMEOUT');
  const {model,capability}=stage;
  model.validate?.(capability,parameters);
  return model.run(task,{capabilityId:capability.id,mode:'chat',parameters,assets},{timeout});
}

export function voiceTurnProvider(providers) {
  return {
    nonRepeatable:true,
    supports(capability) {
      if (capability.id!=='model.voice-turn') return false;
      return stages.every(([,id])=>[...providers.values()].some(model=>model.signature && model.supports(catalog.get(id))));
    },
    taskConfiguration(parameters) {
      return modelsFor(providers,parameters).map(({model})=>model.signature);
    },
    async run(task,payload) {
      let selected;
      try {selected=modelsFor(providers,payload.parameters);} catch {throw changed();}
      if (selected.some(({model},index)=>model.signature!==task.input.providerConfiguration?.[index])) throw changed();
      const [transcription,chat,speech]=selected;
      const {language,voice,instructions}=payload.parameters;
      const deadline=Date.now()+90000;
      try {
        const transcript=checkedText(await invoke(transcription,deadline,task,{...(language && {language})},payload.assets));
        const messages=[...(instructions?[{role:'system',content:instructions}]:[]),{role:'user',content:transcript}];
        const answer=checkedText(await invoke(chat,deadline,task,{messages}));
        const audio=await invoke(speech,deadline,task,{input:answer,voice});
        if (!(audio instanceof GeneratedFile) || audio.mediaType!=='audio/mpeg') throw new ProviderError('VOICE_AUDIO_INVALID');
        return new GeneratedFile(audio.bytes,audio.mediaType,{transcript,answer,models:selected.map(({model})=>model.info.id)});
      } catch (error) {
        // A completed upstream stage may already have incurred a charge.
        if (error instanceof ProviderError || error instanceof ApiError) throw new ProviderError(error.code);
        throw error;
      }
    },
  };
}
