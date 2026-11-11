/**
 * HTML option pipeline for the options review (show_options), step 2 and 3:
 *
 *  1. The agent writes a static HTML + CSS page (no JS).
 *  2. `inspectMockupHtml` (validator) parses it with parse5 and postcss and
 *     reports every disallowed element, attribute and resource. Errors go
 *     back to the agent, which fixes the page and calls again.
 *  3. `sanitizeMockupHtml` (allowlist sanitizer, written for Fhara on top of
 *     parse5 + postcss, both MIT) rebuilds the page from an element and
 *     attribute allowlist, sanitizes CSS, and inlines images from the
 *     review's design folder as data: URIs. Only the sanitized page is
 *     stored.
 *  4. The page is shown in an iframe with `sandbox=""` via srcdoc under a
 *     `default-src 'none'` CSP (lib/optionsReview.ts previewDocument), and
 *     rendered to PNG by `render.ts` with JavaScript off and every network
 *     request blocked.
 *
 * The validator runs again over the sanitizer's output (prepareHtmlOption):
 * a sanitized page that still has an error is refused, never stored.
 */
import { parse, serialize, type DefaultTreeAdapterTypes as T } from "parse5";
import postcss, { type Root as CssRoot } from "postcss";

export type FindingSeverity = "error" | "warn";
export interface HtmlFinding {
  severity: FindingSeverity;
  rule: string;
  detail: string;
}

/** Largest page the agent may submit (characters). */
export const MOCKUP_HTML_MAX = 300_000;
/** Largest single inlined asset (bytes). */
export const MOCKUP_ASSET_MAX = 400_000;
/** Largest sanitized page stored (characters, assets inlined). */
export const MOCKUP_SANITIZED_MAX = 600_000;

const IMAGE_DATA_URI = /^data:image\/(?:png|jpe?g|gif|webp|svg\+xml)(?:;[a-z0-9=.+-]+)*(?:;base64)?,/i;
const ACTIVE_URL_RAW = /^(?:javascript|vbscript|livescript|mocha):/i;
/** Browsers drop ASCII whitespace and control chars inside a URL scheme (`java\tscript:`). */
function stripUrlNoise(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u0020\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\ufeff]/g, "");
}
const ACTIVE_URL = { test: (value: string): boolean => ACTIVE_URL_RAW.test(stripUrlNoise(value)) };
/** A data: URL that is not an image (data:text/html, data:application/…). */
function isActiveDataUrl(value: string): boolean {
  const v = stripUrlNoise(value);
  return /^data:/i.test(v) && !IMAGE_DATA_URI.test(v);
}
const REMOTE_URL = /^\s*(?:[a-z][a-z0-9+.-]*:|\/\/)/i;

/** Elements removed with their content, reported as errors. */
const FORBIDDEN_ELEMENTS = new Set([
  "script",
  "iframe",
  "frame",
  "frameset",
  "object",
  "embed",
  "applet",
  "form",
  "base",
  "portal",
  "noscript",
  "template",
  "link",
  "audio",
  "video",
  "source",
  "track",
  "canvas",
  "math",
  "foreignobject",
  "use",
  "image",
  "animate",
  "animatemotion",
  "animatetransform",
  "set",
  "handler",
  "listener",
]);

const HTML_ELEMENTS = new Set([
  "html", "head", "body", "title", "style", "meta",
  "div", "span", "p", "a", "h1", "h2", "h3", "h4", "h5", "h6", "header", "footer", "main", "nav", "section",
  "article", "aside", "ul", "ol", "li", "dl", "dt", "dd", "table", "thead", "tbody", "tfoot", "tr", "th", "td",
  "caption", "colgroup", "col", "img", "figure", "figcaption", "button", "input", "label", "select", "option",
  "optgroup", "textarea", "fieldset", "legend", "strong", "em", "b", "i", "u", "s", "small", "mark", "code", "pre",
  "kbd", "samp", "blockquote", "q", "cite", "hr", "br", "wbr", "progress", "meter", "time", "abbr", "sub", "sup",
  "details", "summary", "address", "del", "ins",
]);

const SVG_ELEMENTS = new Set([
  "svg", "g", "path", "circle", "rect", "line", "polyline", "polygon", "ellipse", "text", "tspan", "defs",
  "lineargradient", "radialgradient", "stop", "clippath", "mask", "pattern", "symbol", "title", "desc", "style",
]);

const GLOBAL_ATTRS = new Set([
  "class", "id", "style", "title", "lang", "dir", "role", "hidden", "tabindex",
]);

const ELEMENT_ATTRS: Record<string, readonly string[]> = {
  a: ["href"],
  img: ["src", "alt", "width", "height", "loading", "decoding"],
  td: ["colspan", "rowspan", "headers"],
  th: ["colspan", "rowspan", "scope", "headers", "abbr"],
  col: ["span"],
  colgroup: ["span"],
  ol: ["start", "reversed", "type"],
  li: ["value"],
  button: ["type", "disabled", "name", "value"],
  input: ["type", "value", "placeholder", "checked", "disabled", "readonly", "name", "min", "max", "step", "size", "maxlength", "autocomplete"],
  select: ["disabled", "multiple", "name", "size"],
  option: ["value", "selected", "disabled", "label"],
  optgroup: ["label", "disabled"],
  textarea: ["rows", "cols", "placeholder", "disabled", "readonly", "name", "maxlength"],
  label: ["for"],
  fieldset: ["disabled"],
  progress: ["value", "max"],
  meter: ["value", "min", "max", "low", "high", "optimum"],
  time: ["datetime"],
  details: ["open"],
  html: ["lang", "dir"],
  meta: ["charset", "name", "content"],
  del: ["datetime"],
  ins: ["datetime"],
  table: ["border", "cellpadding", "cellspacing"],
};

const SVG_ATTRS = new Set([
  "viewbox", "xmlns", "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray",
  "stroke-dashoffset", "stroke-miterlimit", "d", "cx", "cy", "r", "rx", "ry", "x", "y", "x1", "y1", "x2", "y2",
  "points", "transform", "opacity", "fill-opacity", "stroke-opacity", "fill-rule", "clip-rule", "offset",
  "stop-color", "stop-opacity", "gradientunits", "gradienttransform", "spreadmethod", "clip-path", "mask",
  "font-size", "font-family", "font-weight", "text-anchor", "dominant-baseline", "preserveaspectratio", "width",
  "height", "patternunits", "patterntransform", "maskunits", "clippathunits", "dx", "dy", "vector-effect",
  "aria-hidden", "focusable", "version",
]);

/** Inline CSS properties that can run code or bind behaviour (old IE/Gecko). */
const ACTIVE_CSS = /expression\s*\(|-moz-binding|behaviou?r\s*:|javascript\s*:|vbscript\s*:/i;

export type AssetResolver = (relativePath: string) => { dataUri: string } | { error: string };

type El = T.Element;
type Node = T.ChildNode | T.Document | T.DocumentFragment | T.ParentNode;

function isElement(node: unknown): node is El {
  return Boolean(node && typeof node === "object" && "tagName" in (node as object));
}

function attrName(attr: { name: string; prefix?: string }): string {
  return (attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name).toLowerCase();
}

function textOf(el: El): string {
  return el.childNodes.map((c) => ("value" in c ? (c as T.TextNode).value : "")).join("");
}

function describe(el: El): string {
  return `<${el.tagName}>`;
}

// ─── CSS ──────────────────────────────────────────────────────────────────

/** url(...) references in a CSS value. */
function cssUrls(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi)) out.push((m[1] ?? m[2] ?? m[3] ?? "").trim());
  // image-set("a.png" 1x) and bare strings in image-set count too.
  for (const m of value.matchAll(/image-set\(([^)]*)\)/gi)) {
    for (const s of m[1].matchAll(/"([^"]*)"|'([^']*)'/g)) out.push((s[1] ?? s[2] ?? "").trim());
  }
  return out;
}

function classifyUrl(url: string): "data-image" | "fragment" | "relative" | "active" | "remote" | "data-other" | "empty" {
  if (!url) return "empty";
  if (ACTIVE_URL.test(url)) return "active";
  const bare = stripUrlNoise(url);
  if (/^data:/i.test(bare)) return IMAGE_DATA_URI.test(url) ? "data-image" : "data-other";
  if (url.startsWith("#")) return "fragment";
  if (REMOTE_URL.test(url)) return "remote";
  return "relative";
}

/**
 * A backslash outside a quoted string is a CSS escape (`\75 rl(` is `url(`,
 * `@\69mport` is `@import`). Mockups have no use for them, and they would
 * let a resource hide from the url() and at-rule checks, so they are refused.
 */
function hasCssEscape(value: string): boolean {
  return /\\/.test(value.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""'));
}

function parseCss(css: string, where: string, findings: HtmlFinding[]): CssRoot | null {
  try {
    return postcss.parse(css);
  } catch (error) {
    findings.push({ severity: "error", rule: "css-parse", detail: `${where}: CSS does not parse (${error instanceof Error ? error.message.split("\n")[0] : "error"})` });
    return null;
  }
}

function inspectCss(css: string, where: string, findings: HtmlFinding[], inlineStyle = false): void {
  const root = parseCss(inlineStyle ? `x{${css}}` : css, where, findings);
  if (!root) return;
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (hasCssEscape(rule.name) || hasCssEscape(rule.params)) findings.push({ severity: "error", rule: "css-escape", detail: `${where}: @-rule uses a CSS escape` });
    else if (name === "import") findings.push({ severity: "error", rule: "css-import", detail: `${where}: @import ${rule.params.slice(0, 80)} (inline the CSS instead)` });
    else if (name === "font-face") findings.push({ severity: "warn", rule: "css-font-face", detail: `${where}: @font-face is removed (fonts cannot load in the preview)` });
  });
  root.walkDecls((decl) => {
    const value = decl.value;
    if (hasCssEscape(decl.prop) || hasCssEscape(value)) {
      findings.push({ severity: "error", rule: "css-escape", detail: `${where}: ${decl.prop.slice(0, 40)} uses a CSS escape (write it plainly)` });
      return;
    }
    if (ACTIVE_CSS.test(`${decl.prop}:${value}`)) {
      findings.push({ severity: "error", rule: "css-active", detail: `${where}: ${decl.prop} uses expression/binding/javascript` });
    }
    for (const url of cssUrls(value)) {
      const kind = classifyUrl(url);
      if (kind === "remote") findings.push({ severity: "error", rule: "external-resource", detail: `${where}: url(${url.slice(0, 80)}) loads a remote resource` });
      else if (kind === "active") findings.push({ severity: "error", rule: "javascript-url", detail: `${where}: url(${url.slice(0, 40)}) is a script URL` });
      else if (kind === "data-other") findings.push({ severity: "error", rule: "data-url", detail: `${where}: only data:image URIs are allowed in url()` });
    }
  });
}

function sanitizeCss(css: string, resolveAsset: AssetResolver | undefined, removed: string[], inlineStyle = false): string {
  let root: CssRoot;
  try {
    root = postcss.parse(inlineStyle ? `x{${css}}` : css);
  } catch {
    removed.push("unparseable CSS");
    return "";
  }
  root.walkComments((c) => { c.remove(); });
  root.walkAtRules((rule) => {
    const name = rule.name.toLowerCase();
    if (hasCssEscape(rule.name) || hasCssEscape(rule.params) || name === "import" || name === "font-face" || name === "namespace" || name === "charset") {
      removed.push(`@${name}`);
      rule.remove();
    }
  });
  root.walkDecls((decl) => {
    if (hasCssEscape(decl.prop) || hasCssEscape(decl.value) || ACTIVE_CSS.test(`${decl.prop}:${decl.value}`)) {
      removed.push(`CSS ${decl.prop}`);
      decl.remove();
      return;
    }
    let value = decl.value;
    let drop = false;
    for (const url of cssUrls(value)) {
      const kind = classifyUrl(url);
      if (kind === "data-image" || kind === "fragment" || kind === "empty") continue;
      if (kind === "relative" && resolveAsset) {
        const asset = resolveAsset(url);
        if ("dataUri" in asset) {
          value = value.split(url).join(asset.dataUri);
          continue;
        }
      }
      drop = true;
    }
    if (drop) {
      removed.push(`CSS ${decl.prop} with a non-local url()`);
      decl.remove();
    } else if (value !== decl.value) decl.value = value;
  });
  let out = root.toString();
  if (inlineStyle) out = out.replace(/^\s*x\s*\{/, "").replace(/\}\s*$/, "").trim();
  // A stylesheet never closes its own element.
  return out.replace(/<\/(style)/gi, "<\\/$1");
}

// ─── Validator ────────────────────────────────────────────────────────────

function walk(node: Node, visit: (el: El) => void): void {
  for (const child of (node as T.ParentNode).childNodes ?? []) {
    if (isElement(child)) {
      visit(child);
      walk(child, visit);
      if (child.tagName === "template" && (child as T.Template).content) walk((child as T.Template).content, visit);
    }
  }
}

/**
 * Step 2: report what the page may not contain. `error` findings block the
 * option (the agent fixes and resubmits); `warn` findings are fixed by the
 * sanitizer and only reported.
 */
export function inspectMockupHtml(raw: string, opts: { maxChars?: number } = {}): HtmlFinding[] {
  const findings: HtmlFinding[] = [];
  const max = opts.maxChars ?? MOCKUP_HTML_MAX;
  if (typeof raw !== "string" || !raw.trim()) return [{ severity: "error", rule: "empty", detail: "The page is empty" }];
  if (raw.length > max) {
    findings.push({ severity: "error", rule: "oversized", detail: `The page is ${raw.length.toLocaleString("en-US")} characters; at most ${max.toLocaleString("en-US")}` });
    return findings;
  }
  const doc = parse(raw);
  walk(doc, (el) => {
    const tag = el.tagName.toLowerCase();
    if (FORBIDDEN_ELEMENTS.has(tag)) {
      const rule = tag === "script" ? "script" : tag === "form" ? "form" : tag === "base" ? "base" : tag === "link" ? "external-resource" : "embed";
      findings.push({ severity: "error", rule, detail: `${describe(el)} is not allowed in a static mockup` });
      return;
    }
    if (tag === "meta") {
      const equiv = el.attrs.find((a) => a.name.toLowerCase() === "http-equiv");
      if (equiv) findings.push({ severity: "error", rule: "meta-refresh", detail: `<meta http-equiv="${equiv.value.slice(0, 40)}"> is not allowed` });
    }
    if (!HTML_ELEMENTS.has(tag) && !SVG_ELEMENTS.has(tag)) {
      findings.push({ severity: "warn", rule: "element", detail: `${describe(el)} is not on the allowlist and is removed` });
    }
    if (tag === "style") inspectCss(textOf(el), "<style>", findings);
    for (const attr of el.attrs) {
      const name = attrName(attr);
      const value = attr.value ?? "";
      if (name.startsWith("on")) {
        findings.push({ severity: "error", rule: "event-handler", detail: `${describe(el)} has ${name}= (no JavaScript in mockups)` });
        continue;
      }
      if (name === "style") inspectCss(value, `${describe(el)} style`, findings, true);
      if (ACTIVE_URL.test(value) || /^\s*data:text\/html/i.test(stripUrlNoise(value))) {
        findings.push({ severity: "error", rule: "javascript-url", detail: `${describe(el)} ${name}= uses a script URL` });
        continue;
      }
      if (["src", "href", "xlink:href", "srcset", "poster", "action", "formaction", "background", "data", "codebase", "ping", "cite", "longdesc", "manifest"].includes(name)) {
        const urls = name === "srcset" ? value.split(",").map((part) => part.trim().split(/\s+/)[0] ?? "") : [value.trim()];
        for (const url of urls) {
          const kind = classifyUrl(url);
          if (kind === "remote" && tag === "a" && name === "href") {
            findings.push({ severity: "warn", rule: "link", detail: `${describe(el)} href="${url.slice(0, 80)}" is kept as text; mockup links go nowhere` });
          } else if (kind === "remote") {
            findings.push({ severity: "error", rule: "external-resource", detail: `${describe(el)} ${name}="${url.slice(0, 80)}" points outside the page` });
          } else if (kind === "data-other") {
            findings.push({ severity: "error", rule: "data-url", detail: `${describe(el)} ${name}= only data:image URIs are allowed` });
          }
        }
      }
    }
  });
  return findings;
}

// ─── Sanitizer ────────────────────────────────────────────────────────────

function allowedAttr(tag: string, name: string, isSvg: boolean): boolean {
  if (name.startsWith("on")) return false;
  if (GLOBAL_ATTRS.has(name) || name.startsWith("aria-") || name.startsWith("data-")) return true;
  if (isSvg) return SVG_ATTRS.has(name);
  return (ELEMENT_ATTRS[tag] ?? []).includes(name);
}

function sanitizeChildren(parent: T.ParentNode, resolveAsset: AssetResolver | undefined, removed: string[], inSvg: boolean): void {
  const kept: T.ChildNode[] = [];
  for (const child of parent.childNodes) {
    if (child.nodeName === "#comment") continue;
    if (!isElement(child)) {
      kept.push(child);
      continue;
    }
    const tag = child.tagName.toLowerCase();
    const isSvg = inSvg || tag === "svg";
    const known = isSvg ? SVG_ELEMENTS.has(tag) : HTML_ELEMENTS.has(tag);
    if (FORBIDDEN_ELEMENTS.has(tag)) {
      removed.push(`<${tag}>`);
      continue;
    }
    if (!known) {
      // Unknown element: drop the tag, keep its (sanitized) content.
      removed.push(`<${tag}> (kept its text)`);
      sanitizeChildren(child, resolveAsset, removed, isSvg);
      for (const grand of child.childNodes) {
        grand.parentNode = parent;
        kept.push(grand);
      }
      continue;
    }
    if (tag === "meta" && !child.attrs.some((a) => a.name.toLowerCase() === "charset")) {
      const name = child.attrs.find((a) => a.name.toLowerCase() === "name")?.value.toLowerCase();
      if (name !== "viewport") {
        removed.push("<meta>");
        continue;
      }
    }
    const attrs: T.Element["attrs"] = [];
    for (const attr of child.attrs) {
      const name = attrName(attr);
      let value = attr.value ?? "";
      if (!allowedAttr(tag, name, isSvg)) {
        removed.push(`${name}= on <${tag}>`);
        continue;
      }
      if (ACTIVE_URL.test(value) || (isActiveDataUrl(value) && !(tag === "img" && name === "src"))) {
        removed.push(`${name}= script URL`);
        continue;
      }
      if (name === "style") {
        value = sanitizeCss(value, resolveAsset, removed, true);
        if (!value) continue;
      }
      if (tag === "meta" && name === "content" && /url\s*=/i.test(value)) {
        removed.push("meta content URL");
        continue;
      }
      if (tag === "img" && name === "src") {
        const kind = classifyUrl(value.trim());
        if (kind === "relative" && resolveAsset) {
          const asset = resolveAsset(value.trim());
          if ("dataUri" in asset) value = asset.dataUri;
          else {
            removed.push(`img src "${value.slice(0, 60)}" (${asset.error})`);
            continue;
          }
        } else if (kind !== "data-image") {
          removed.push(`img src "${value.slice(0, 60)}"`);
          continue;
        }
      }
      if (tag === "a" && name === "href" && classifyUrl(value.trim()) !== "fragment") {
        // Links in a mockup go nowhere; keep the look, drop the target.
        value = "#";
      }
      attrs.push({ name: attr.prefix ? `${attr.prefix}:${attr.name}` : attr.name, value });
    }
    child.attrs = attrs;
    if (tag === "style") {
      const css = sanitizeCss(textOf(child), resolveAsset, removed);
      const textNode = child.childNodes.find((c) => c.nodeName === "#text") as T.TextNode | undefined;
      child.childNodes = textNode ? [Object.assign(textNode, { value: css })] : [];
      kept.push(child);
      continue;
    }
    sanitizeChildren(child, resolveAsset, removed, isSvg);
    kept.push(child);
  }
  parent.childNodes = kept;
}

/**
 * Step 3: rebuild the page from the allowlist. Returns a full document
 * (doctype, html, head with meta charset, body). `removed` lists what was
 * dropped (for the agent and the card's findings).
 */
export function sanitizeMockupHtml(raw: string, opts: { resolveAsset?: AssetResolver } = {}): { html: string; removed: string[] } {
  const removed: string[] = [];
  const doc = parse(raw);
  sanitizeChildren(doc, opts.resolveAsset, removed, false);
  const html = doc.childNodes.find((c) => isElement(c) && c.tagName === "html") as El | undefined;
  if (html) {
    const head = html.childNodes.find((c) => isElement(c) && c.tagName === "head") as El | undefined;
    if (head && !head.childNodes.some((c) => isElement(c) && c.tagName === "meta" && c.attrs.some((a) => a.name === "charset"))) {
      head.childNodes.unshift({
        nodeName: "meta",
        tagName: "meta",
        attrs: [{ name: "charset", value: "utf-8" }],
        namespaceURI: "http://www.w3.org/1999/xhtml",
        childNodes: [],
        parentNode: head,
      } as unknown as T.ChildNode);
    }
  }
  const body = serialize(doc).replace(/^<!DOCTYPE[^>]*>/i, "");
  return { html: `<!doctype html>${body}`, removed: Array.from(new Set(removed)) };
}

export type PreparedHtmlOption =
  | { ok: true; html: string; warnings: string[] }
  | { ok: false; findings: HtmlFinding[] };

/**
 * The whole server-side gate for one html option: validate (errors go back
 * to the agent), sanitize, validate the sanitized output again, cap size.
 */
export function prepareHtmlOption(raw: string, opts: { resolveAsset?: AssetResolver; maxChars?: number } = {}): PreparedHtmlOption {
  const findings = inspectMockupHtml(raw, { maxChars: opts.maxChars });
  const errors = findings.filter((f) => f.severity === "error");
  if (errors.length) return { ok: false, findings: errors };
  const { html, removed } = sanitizeMockupHtml(raw, { resolveAsset: opts.resolveAsset });
  const after = inspectMockupHtml(html, { maxChars: MOCKUP_SANITIZED_MAX }).filter((f) => f.severity === "error");
  if (after.length) return { ok: false, findings: after.map((f) => ({ ...f, detail: `after sanitizing: ${f.detail}` })) };
  const warnings = [...findings.filter((f) => f.severity === "warn").map((f) => f.detail), ...removed.map((r) => `removed ${r}`)];
  return { ok: true, html, warnings: Array.from(new Set(warnings)).slice(0, 20) };
}

/** Findings as text the agent can act on. */
export function formatFindings(optionId: string, findings: readonly HtmlFinding[]): string {
  return [`Option ${optionId} was not accepted. Fix these and call show_options again:`, ...findings.slice(0, 20).map((f) => `- [${f.rule}] ${f.detail}`)].join("\n");
}
