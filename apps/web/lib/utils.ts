export { cn } from "cn"

/** A stable pick from `list` for a name (sum of char codes), e.g. an avatar tone. */
export function pickByName<T>(name: string, list: readonly T[]): T {
  return list[[...name].reduce((acc, ch) => acc + ch.charCodeAt(0), 0) % list.length];
}
