// Error HTTP con código de estado y mensaje en español apto para mostrar al usuario.
export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}
