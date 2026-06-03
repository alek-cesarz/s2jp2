export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ParseError';
  }
}

export class ProfileMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileMismatchError';
  }
}

export class WindowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WindowError';
  }
}
