/** Een fout met een HTTP-status en een Nederlandse melding die de gebruiker mag zien. */
export class Problem extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function check(ok: unknown, message: string, status = 400): asserts ok {
  if (!ok) throw new Problem(status, message);
}
