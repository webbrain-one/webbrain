import { AnthropicProvider } from './anthropic.js';

/**
 * Anthropic Claude through Vertex AI's rawPredict/streamRawPredict endpoints.
 * Authentication uses a user-created Google authorization key rather than an
 * interactive OAuth flow.
 */
export class VertexAnthropicProvider extends AnthropicProvider {
  get name() {
    return 'google-vertex-anthropic';
  }

  get supportsVision() {
    return this.config.supportsVision !== false;
  }

  _vertexCoordinates() {
    const project = String(this.config.project || '').trim();
    const location = String(this.config.location || '').trim();
    if (!/^[a-z][a-z0-9:._-]{4,127}$/i.test(project)) {
      throw new Error('Google Cloud project ID is required.');
    }
    if (!/^[a-z0-9-]+$/i.test(location)) {
      throw new Error('Google Cloud location is required.');
    }
    if (!String(this.config.apiKey || '').trim()) {
      throw new Error('Google authorization key is required.');
    }
    return { project, location };
  }

  _headers() {
    return {
      'Content-Type': 'application/json',
      'x-goog-api-key': String(this.config.apiKey || ''),
    };
  }

  _vertexEndpointHost(location) {
    const normalized = String(location || '').trim().toLowerCase();
    if (normalized === 'global') return 'aiplatform.googleapis.com';
    if (normalized === 'us' || normalized === 'eu') {
      return `aiplatform.${normalized}.rep.googleapis.com`;
    }
    return `${normalized}-aiplatform.googleapis.com`;
  }

  _messagesUrl(stream = false) {
    const { project, location } = this._vertexCoordinates();
    const action = stream ? 'streamRawPredict' : 'rawPredict';
    const endpointHost = this._vertexEndpointHost(location);
    return `https://${endpointHost}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/publishers/anthropic/models/${encodeURIComponent(this.model)}:${action}`;
  }

  _prepareRequestBody(body, _options = {}, stream = false) {
    const { model: _model, stream: _stream, ...payload } = body;
    return {
      ...payload,
      anthropic_version: 'vertex-2023-10-16',
      ...(stream ? { stream: true } : {}),
    };
  }
}
