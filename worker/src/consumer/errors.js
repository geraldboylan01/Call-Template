export class ConsumerError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'ConsumerError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, code = 'invalid_request', details) {
  return new ConsumerError(400, code, message, details);
}

export function notFound(message = 'Not found.') {
  return new ConsumerError(404, 'not_found', message);
}

export function unavailable(message = 'This planning journey is not available right now.', code = 'consumer_unavailable') {
  return new ConsumerError(503, code, message);
}
