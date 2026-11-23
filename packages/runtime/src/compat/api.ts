function makeReference(path: string): any {
  const target = function () {} as any;
  Object.defineProperty(target, "__fharaPath", { value: path, enumerable: false });
  return new Proxy(target, {
    get(_current, property) {
      if (property === "__fharaPath") return path;
      if (property === "then" || property === Symbol.toPrimitive || property === Symbol.toStringTag) {
        return undefined;
      }
      if (typeof property === "symbol") return undefined;
      return makeReference(path ? `${path}:${property}` : property);
    },
    apply() {
      throw new Error(`Function reference ${path} is not callable; pass it to a client method`);
    },
  });
}

export const api: any = makeReference("");
export const internal: any = makeReference("");
export const components: any = makeReference("components");
export const anyApi: any = api;
