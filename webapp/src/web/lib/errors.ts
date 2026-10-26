/** An API answer with an error. `message` is written for humans; `code` is the API's error code. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
