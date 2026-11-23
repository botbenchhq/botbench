/** A request of the owner's about pairing or messages that cannot be met; `status` is the HTTP answer for it. */
export class PeerError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
