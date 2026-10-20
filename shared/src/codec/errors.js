/** Повідомлення не вдалося розібрати або воно порушує протокол. Сервер у відповідь закриває сокет. */
export class CodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'CodecError';
  }
}
