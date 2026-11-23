import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getFunctionName } from "../compat/server";

type Listener = () => void;

function keyOf(reference: unknown, args: unknown): string {
  return `${getFunctionName(reference)}|${JSON.stringify(args ?? {})}`;
}

export class FharaRuntimeReactClient {
  private readonly cache = new Map<string, unknown>();
  private readonly listeners = new Set<Listener>();
  private readonly base: string;

  constructor(url?: string) {
    const configured = url ?? (typeof process !== "undefined" ? process.env.FHARA_BACKEND_URL : undefined);
    this.base = (configured ?? "http://127.0.0.1:8787").replace(/\/$/, "");
  }

  private async call<T>(kind: "query" | "mutation" | "action", reference: unknown, args: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.base}/local/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: getFunctionName(reference), args: args ?? {} }),
    });
    const body = await response.json() as { value?: T; error?: string };
    if (!response.ok) throw new Error(body.error ?? `Local backend error ${response.status}`);
    return body.value as T;
  }

  query<T = any>(reference: unknown, args: any = {}): Promise<T> {
    return this.call<T>("query", reference, args);
  }

  mutation<T = any>(reference: unknown, args: any = {}): Promise<T> {
    return this.call<T>("mutation", reference, args);
  }

  action<T = any>(reference: unknown, args: any = {}): Promise<T> {
    return this.call<T>("action", reference, args);
  }

  peek(reference: unknown, args: unknown): unknown {
    return this.cache.get(keyOf(reference, args));
  }

  put(reference: unknown, args: unknown, value: unknown): void {
    this.cache.set(keyOf(reference, args), value);
    this.emit();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  async refresh(reference: unknown, args: Record<string, unknown>): Promise<void> {
    const key = keyOf(reference, args);
    try {
      this.cache.set(key, await this.query(reference, args));
      this.emit();
    } catch {
      // keep the previous value on a transient refetch failure
    }
  }

  allQueries(reference: unknown): Array<{ args: Record<string, unknown>; value: unknown }> {
    const path = getFunctionName(reference);
    const results: Array<{ args: Record<string, unknown>; value: unknown }> = [];
    for (const [key, value] of this.cache) {
      const [keyPath, rawArgs] = key.split("|");
      if (keyPath === path) results.push({ args: JSON.parse(rawArgs), value });
    }
    return results;
  }
}

const FharaRuntimeContext = createContext<FharaRuntimeReactClient | null>(null);

export function FharaRuntimeProvider({ client, children }: { client: FharaRuntimeReactClient; children: ReactNode }) {
  return <FharaRuntimeContext.Provider value={client}>{children}</FharaRuntimeContext.Provider>;
}

export function useFharaRuntime(): FharaRuntimeReactClient {
  const client = useContext(FharaRuntimeContext);
  if (!client) throw new Error("FharaRuntimeProvider is missing");
  return client;
}

export function useQuery<T = any>(reference: unknown, args: unknown): any {
  const client = useFharaRuntime();
  const [value, setValue] = useState<T | undefined>(() => client.peek(reference, args) as T | undefined);
  const argsKey = useMemo(() => JSON.stringify(args ?? {}), [args]);

  useEffect(() => {
    if (args === "skip") {
      setValue(undefined);
      return;
    }
    let active = true;
    const sync = () => {
      if (!active) return;
      const next = client.peek(reference, args) as T | undefined;
      setValue(next);
    };
    const unsubscribe = client.subscribe(sync);
    void client.refresh(reference, args as Record<string, unknown>).then(sync);
    const timer = setInterval(() => void client.refresh(reference, args as Record<string, unknown>), 1000);
    return () => {
      active = false;
      unsubscribe();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, getFunctionName(reference), argsKey, args === "skip"]);

  return value;
}

type OptimisticStore = {
  getQuery: (reference: unknown, args: unknown) => unknown;
  setQuery: (reference: unknown, args: unknown, value: unknown) => void;
  getAllQueries: (reference: unknown) => Array<{ args: Record<string, unknown>; value: unknown }>;
};

type CallableMutation = ((args?: any) => Promise<any>) & {
  withOptimisticUpdate: (updater: (store: OptimisticStore, args: any) => void) => CallableMutation;
};

function makeCallable(
  client: FharaRuntimeReactClient,
  kind: "mutation" | "action",
  reference: unknown
): CallableMutation {
  const invoke = async (args: any = {}) => {
    const result = await client[kind](reference, args);
    await client.refresh(reference, {});
    client.emit();
    return result;
  };
  const callable = invoke as CallableMutation;
  callable.withOptimisticUpdate = (updater) => {
    const wrapped = (async (args: any = {}) => {
      const store: OptimisticStore = {
        getQuery: (ref, queryArgs) => client.peek(ref, queryArgs),
        setQuery: (ref, queryArgs, value) => client.put(ref, queryArgs, value),
        getAllQueries: (ref) => client.allQueries(ref),
      };
      updater(store, args);
      return await invoke(args);
    }) as CallableMutation;
    wrapped.withOptimisticUpdate = callable.withOptimisticUpdate;
    return wrapped;
  };
  return callable;
}

export function useMutation(reference: unknown): CallableMutation {
  const client = useFharaRuntime();
  const ref = useRef(reference);
  ref.current = reference;
  return useMemo(() => makeCallable(client, "mutation", ref.current), [client]);
}

export function useAction(reference: unknown): CallableMutation {
  const client = useFharaRuntime();
  const ref = useRef(reference);
  ref.current = reference;
  return useMemo(() => makeCallable(client, "action", ref.current), [client]);
}

export function useQueries(entries: Record<string, { query: unknown; args: unknown }>): any {
  const client = useFharaRuntime();
  const [, force] = useState(0);
  const keys = Object.keys(entries).join("|");
  useEffect(() => client.subscribe(() => force((value) => value + 1)), [client]);
  return Object.fromEntries(
    Object.entries(entries).map(([key, entry]) => [key, client.peek(entry.query, entry.args)])
  );
}
