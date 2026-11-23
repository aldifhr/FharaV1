export class NextRequest extends Request {
  readonly nextUrl: URL;

  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input as RequestInfo, init);
    this.nextUrl = new URL(this.url);
  }
}

export type NextResponse = Response;

export const NextResponse = {
  json(body: unknown, init?: ResponseInit): Response {
    return new Response(JSON.stringify(body), {
      ...init,
      headers: { "content-type": "application/json; charset=utf-8", ...(init?.headers ?? {}) },
    });
  },
  redirect(url: string | URL, init?: ResponseInit): Response {
    return new Response(null, {
      ...init,
      status: init?.status ?? 307,
      headers: { location: String(url), ...(init?.headers ?? {}) },
    });
  },
};
