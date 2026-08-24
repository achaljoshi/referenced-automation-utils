export class CommonsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CommonsError';
    Object.setPrototypeOf(this, CommonsError.prototype);
  }
}
