import { validMedia } from './assets.js';
import { ProviderError } from './model-http.js';

const maxBytes = 10 * 1024 * 1024;

export class GeneratedFile {
  constructor(bytes, mediaType) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > maxBytes || !validMedia(bytes, mediaType)) {
      throw new ProviderError('INVALID_GENERATED_FILE');
    }
    this.bytes = bytes;
    this.mediaType = mediaType;
  }

  static image(base64, declaredType) {
    if (typeof base64 !== 'string' || !base64.length || base64.length > 4 * Math.ceil(maxBytes / 3)) {
      throw new ProviderError('INVALID_PROVIDER_IMAGE');
    }
    const bytes = Buffer.from(base64, 'base64');
    const type = ['image/png', 'image/jpeg'].find(mime => validMedia(bytes, mime));
    if (!type || (declaredType && declaredType !== type) || bytes.toString('base64') !== base64) throw new ProviderError('INVALID_PROVIDER_IMAGE');
    return new GeneratedFile(bytes, type);
  }
}
