export class FatalPhaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FatalPhaseError';
  }
}
