import { getFunctionName } from "../compat/server";

function backendUrl(url?: string): string {
  const base = url ?? process.env.FHARA_BACKEND_URL ?? process.env.FHARA_BACKEND_URL ?? "http://127.0.0.1:8787";
  return base.replace(/\/$/, "");
}

async function call<T = any>(base: string, kind: "query" | "mutation" | "action", reference: unknown, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`${base}/local/${kind}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: getFunctionName(reference), args: args ?? {} }),
  });
  const body = await response.json() as { value?: T; error?: string };
  if (!response.ok) throw new Error(body.error ?? `Local backend error ${response.status}`);
  return body.value as T;
}

export class FharaRuntimeHttpClient {
  constructor(private readonly url?: string) {}

  query<T = any>(reference: unknown, args: Record<string, unknown> = {}): Promise<T> {
    return call<T>(backendUrl(this.url), "query", reference, args);
  }

  mutation<T = any>(reference: unknown, args: Record<string, unknown> = {}): Promise<T> {
    return call<T>(backendUrl(this.url), "mutation", reference, args);
  }

  action<T = any>(reference: unknown, args: Record<string, unknown> = {}): Promise<T> {
    return call<T>(backendUrl(this.url), "action", reference, args);
  }
}

export class FharaRuntimeClient {
  constructor(private readonly url?: string, _options?: any) {}

  onUpdate(reference: unknown, args: Record<string, unknown>, onChange: (value: any) => void, onError?: (error: Error) => void): () => void {
    let last = "";
    let stopped = false;
    const poll = async () => {
      if (stopped) return;
      try {
        const value = await this.query(reference, args);
        const serialized = JSON.stringify(value ?? null);
        if (serialized !== last) {
          last = serialized;
          onChange(value);
        }
      } catch (error) {
        onError?.(error as Error);
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }

  query<T = any>(reference: unknown, args: Record<string, unknown> = {}): Promise<T> {
    return call<T>(backendUrl(this.url), "query", reference, args);
  }

  mutation<T = any>(reference: unknown, args: Record<string, unknown> = {}): Promise<T> {
    return call<T>(backendUrl(this.url), "mutation", reference, args);
  }

  action<T = any>(reference: unknown, args: Record<string, unknown> = {}): Promise<T> {
    return call<T>(backendUrl(this.url), "action", reference, args);
  }

  close(): void {}
}
