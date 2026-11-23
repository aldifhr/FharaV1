import {
  lazy,
  Suspense,
  useMemo,
  type ReactNode,
} from "react";
import {
  Link as RouterLink,
  useLocation,
  useNavigate,
  useParams as useRouterParams,
  useSearchParams as useRouterSearchParams,
} from "react-router-dom";

export type Metadata = { title?: string; description?: string };

export function Link({ href, prefetch: _prefetch, ...props }: any) {
  return <RouterLink to={href ?? "#"} {...props} />;
}

export function useRouter() {
  const navigate = useNavigate();
  return useMemo(
    () => ({
      push: (href: string) => navigate(href),
      replace: (href: string) => navigate(href, { replace: true }),
      back: () => navigate(-1),
      forward: () => navigate(1),
      refresh: () => window.location.reload(),
      prefetch: () => {},
    }),
    [navigate]
  );
}

export function useSearchParams() {
  return useRouterSearchParams()[0];
}

export function useParams<T = Record<string, string | undefined>>(): T {
  return useRouterParams() as T;
}

export function usePathname() {
  return useLocation().pathname;
}

export function useSelectedLayoutSegment() {
  return useLocation().pathname.split("/").filter(Boolean)[0] ?? null;
}

export function redirect(href: string): never {
  window.location.replace(href);
  return undefined as never;
}

export function notFound(): never {
  throw new Error("Not found");
}

export function dynamic<T = any>(
  loader: () => Promise<any>,
  options?: { ssr?: boolean; loading?: () => ReactNode }
) {
  const Lazy = lazy(loader as any);
  return function DynamicComponent(props: any) {
    return (
      <Suspense fallback={options?.loading ? options.loading() : null}>
        <Lazy {...props} />
      </Suspense>
    );
  } as T;
}

const noFont = { variable: "", className: "", style: {} };
export const Geist = (..._args: any[]) => noFont;
export const Inter = (..._args: any[]) => noFont;
export const JetBrains_Mono = (..._args: any[]) => noFont;
