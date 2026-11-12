import { describe, expect, test } from "vitest";
import { parse, type DefaultTreeAdapterTypes as T } from "parse5";
import { htmlLooksActive, previewDocument } from "@/api/convex/lib/optionsReview";
import { inspectMockupHtml, prepareHtmlOption, sanitizeMockupHtml } from "./htmlPreview";

/** Every way a page could run code, load a resource or navigate. */
const XSS_CORPUS: Array<[string, string]> = [
  ["script", "<p>x</p><script>alert(1)</script>"],
  ["script uppercase", "<SCRIPT SRC=//evil.test/x.js></SCRIPT>"],
  ["script in svg", "<svg><script>alert(1)</script></svg>"],
  ["onerror", '<img src="a.png" onerror="alert(1)">'],
  ["onclick odd case", "<div OnClick=alert(1)>x</div>"],
  ["onload body", "<body onload=alert(1)><p>x</p></body>"],
  ["svg onload", "<svg onload=alert(1)><circle r=5 /></svg>"],
  ["svg animate href", '<svg><a><animate attributeName="href" values="javascript:alert(1)"/><text>x</text></a></svg>'],
  ["svg set", '<svg><set attributeName="onmouseover" to="alert(1)"/></svg>'],
  ["svg use remote", '<svg><use href="https://evil.test/s.svg#x"/></svg>'],
  ["svg image", '<svg><image href="https://evil.test/a.png"/></svg>'],
  ["svg xlink javascript", '<svg><a xlink:href="javascript:alert(1)"><text>x</text></a></svg>'],
  ["svg foreignObject", "<svg><foreignObject><iframe src=//evil.test></iframe></foreignObject></svg>"],
  ["a javascript", '<a href="javascript:alert(1)">x</a>'],
  ["a vbscript", '<a href="vbscript:msgbox(1)">x</a>'],
  ["a data html", '<a href="data:text/html,<script>alert(1)</script>">x</a>'],
  ["a data html base64", '<a href="DATA:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">x</a>'],
  ["a tab in scheme", '<a href="java\tscript:alert(1)">x</a>'],
  ["a entity tab in scheme", '<a href="java&#x09;script:alert(1)">x</a>'],
  ["a entity encoded", '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;alert(1)">x</a>'],
  ["a entity no semicolons", '<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A;alert(1)">x</a>'],
  ["a leading space+control", '<a href=" \u0001javascript:alert(1)">x</a>'],
  ["a nul becomes U+FFFD", '<a href="\u0000javascript:alert(1)">x</a>'],
  ["img javascript", '<img src="javascript:alert(1)">'],
  ["img remote", '<img src="https://evil.test/track.png">'],
  ["img protocol-relative", '<img src="//evil.test/track.png">'],
  ["img data html", '<img src="data:text/html,<script>alert(1)</script>">'],
  ["srcset remote", '<img src="a.png" srcset="https://evil.test/a.png 1x, b.png 2x">'],
  ["iframe", '<iframe src="https://evil.test"></iframe>'],
  ["iframe srcdoc", '<iframe srcdoc="<script>alert(1)</script>"></iframe>'],
  ["object", '<object data="https://evil.test/x.swf"></object>'],
  ["embed", '<embed src="https://evil.test/x.swf">'],
  ["form", '<form action="https://evil.test"><input name=q><button>Go</button></form>'],
  ["button formaction", '<button formaction="javascript:alert(1)">x</button>'],
  ["input image", '<input type="image" src="https://evil.test/a.png">'],
  ["base", '<head><base href="https://evil.test/"></head><body><img src="a.png"></body>'],
  ["meta refresh", '<head><meta http-equiv="refresh" content="0;url=https://evil.test"></head>'],
  ["meta refresh with charset", '<head><meta charset="utf-8" http-equiv="refresh" content="0;url=javascript:alert(1)"></head>'],
  ["link stylesheet", '<link rel="stylesheet" href="https://evil.test/a.css">'],
  ["style expression", "<style>p{width:expression(alert(1))}</style>"],
  ["inline style expression", '<p style="width: expression(alert(1))">x</p>'],
  ["moz binding", '<p style="-moz-binding:url(https://evil.test/x.xml#x)">x</p>'],
  ["style url http", "<style>body{background:url(http://evil.test/a.png)}</style>"],
  ["style url quoted", '<style>body{background:url("https://evil.test/a.png")}</style>'],
  ["style url javascript", "<style>body{background:url(javascript:alert(1))}</style>"],
  ["inline url http", '<div style="background-image:url(//evil.test/a.png)">x</div>'],
  ["image-set remote", '<div style="background-image:image-set(&quot;https://evil.test/a.png&quot; 1x)">x</div>'],
  ["@import", "<style>@import url(https://evil.test/a.css); p{color:red}</style>"],
  ["@import string", "<style>@import 'https://evil.test/a.css';</style>"],
  ["escaped @import", "<style>@\\69mport url(https://evil.test/a.css);</style>"],
  ["escaped url()", "<style>body{background:\\75 rl(https://evil.test/a.png)}</style>"],
  ["escaped url inline", '<p style="background:u\\72l(https://evil.test/a.png)">x</p>'],
  ["font-face remote", "<style>@font-face{font-family:x;src:url(https://evil.test/f.woff)}</style>"],
  ["style breakout", "<style>p{color:red}</style><script>alert(1)</script>"],
  ["noscript trick", '<noscript><p title="</noscript><img src=x onerror=alert(1)>"></noscript>'],
  ["template trick", "<template><script>alert(1)</script><img src=x onerror=alert(1)></template>"],
  ["comment breakout", "<!--><script>alert(1)</script>-->"],
  ["comment bang", "<!-- --!><img src=x onerror=alert(1)>-->"],
  ["conditional comment", "<!--[if IE]><script>alert(1)</script><![endif]-->"],
  ["cdata html", "<![CDATA[<script>alert(1)</script>]]>"],
  ["cdata svg", "<svg><![CDATA[</svg><img src=x onerror=alert(1)>]]></svg>"],
  ["math mglyph", "<math><mtext><table><mglyph><style><img src=x onerror=alert(1)></style></mglyph></table></mtext></math>"],
  ["unknown element handler", "<x-card onmouseover=alert(1)><b>x</b></x-card>"],
  ["textarea breakout", "<textarea></textarea><script>alert(1)</script></textarea>"],
  ["title breakout", "<title></title><img src=x onerror=alert(1)></title>"],
  ["audio/video", '<video src="https://evil.test/v.mp4" poster="https://evil.test/p.png"></video>'],
  ["frameset", '<frameset><frame src="https://evil.test"></frameset>'],
  ["portal", '<portal src="https://evil.test"></portal>'],
];

const ACTIVE_SCHEME = /^(?:javascript|vbscript|livescript|mocha|data:text\/html)/i;
const FORBIDDEN = new Set(["script", "iframe", "frame", "frameset", "object", "embed", "form", "base", "link", "noscript", "template", "video", "audio", "portal", "use", "image", "animate", "set", "foreignobject", "math"]);

/** The sanitized page must be inert: no code, no remote load, no navigation. */
function assertInert(html: string, label: string): void {
  expect(htmlLooksActive(html), label).toBeNull();
  const visit = (node: T.ParentNode): void => {
    for (const child of node.childNodes ?? []) {
      if (!("tagName" in child)) continue;
      const el = child as T.Element;
      expect(FORBIDDEN.has(el.tagName.toLowerCase()), `${label}: <${el.tagName}>`).toBe(false);
      for (const attr of el.attrs) {
        const name = attr.name.toLowerCase();
        // eslint-disable-next-line no-control-regex -- strips control characters on purpose
        const value = attr.value.replace(/[\u0000-\u0020]/g, "");
        expect(name.startsWith("on"), `${label}: ${name}=`).toBe(false);
        expect(["srcset", "formaction", "action", "poster", "background", "xlink:href", "http-equiv"].includes(name), `${label}: ${name}=`).toBe(false);
        expect(ACTIVE_SCHEME.test(value), `${label}: ${name}=${attr.value}`).toBe(false);
        if (name === "src") expect(/^data:image\//i.test(value), `${label}: src=${attr.value}`).toBe(true);
        if (name === "href") expect(value.startsWith("#"), `${label}: href=${attr.value}`).toBe(true);
        if (name === "style") expect(/url\(|\\|expression|binding/i.test(value), `${label}: style=${attr.value}`).toBe(false);
        if (name === "content") expect(/url\s*=/i.test(value), `${label}: content=${attr.value}`).toBe(false);
      }
      if (el.tagName === "style") {
        const css = el.childNodes.map((c) => ("value" in c ? (c as T.TextNode).value : "")).join("");
        const unquoted = css.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
        expect(/@import|@font-face|expression|url\(\s*["']?\s*(?:https?:|\/\/|javascript)/i.test(css), `${label}: css ${css}`).toBe(false);
        expect(unquoted.includes("\\"), `${label}: css escape ${css}`).toBe(false);
      }
      visit(el);
      if (el.tagName === "template") visit((el as T.Template).content);
    }
  };
  visit(parse(html));
}

describe("mockup validator + sanitizer: XSS corpus", () => {
  test.each(XSS_CORPUS)("%s: the sanitizer alone produces an inert page", (label, payload) => {
    const { html } = sanitizeMockupHtml(payload);
    assertInert(html, label);
  });

  test.each(XSS_CORPUS)("%s: the full gate refuses it or stores an inert page", (label, payload) => {
    const result = prepareHtmlOption(payload);
    if (result.ok) assertInert(result.html, label);
  });

  test.each(XSS_CORPUS.filter(([label]) => !/^(cdata html|cdata svg|a nul becomes|comment|conditional comment|title breakout|textarea breakout|unknown element|font-face)/.test(label)))(
    "%s: the validator reports an error the agent must fix",
    (label, payload) => {
      const errors = inspectMockupHtml(payload).filter((f) => f.severity === "error");
      expect(errors.length, label).toBeGreaterThan(0);
    }
  );

  test("comment, CDATA and textarea tricks lose nothing dangerous", () => {
    for (const payload of ["<!--><script>alert(1)</script>-->", "<textarea></textarea><script>alert(1)</script></textarea>"]) {
      expect(prepareHtmlOption(payload).ok).toBe(false);
    }
    const cdata = prepareHtmlOption("<p>a</p><![CDATA[<script>alert(1)</script>]]>");
    // HTML treats CDATA as a bogus comment; the sanitizer drops comments.
    if (cdata.ok) expect(cdata.html).not.toMatch(/<script/i);
  });
});

describe("mockup sanitizer keeps a legitimate page", () => {
  const PAGE = `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Inbox</title>
<style>:root{--ink:#111}body{font:14px system-ui;color:var(--ink)} .card{border:1px solid #ddd;background:url(data:image/png;base64,AAAA)} p::before{content:"\\2014"}</style></head>
<body><main class="grid" aria-label="Inbox"><section class="card" style="padding:8px"><h2>Today</h2><a href="#detail">Open</a>
<a href="https://example.com/x">External</a><img src="data:image/png;base64,AAAA" alt="avatar" width="20">
<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M0 0L10 10" stroke="currentColor"/></svg>
<button type="button">Reply</button><input type="text" placeholder="Search"></section></main></body></html>`;

  test("structure, classes, inline styles, svg, data images and fragment links survive", () => {
    const result = prepareHtmlOption(PAGE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html.startsWith("<!doctype html>")).toBe(true);
    expect(result.html).toContain('<meta charset="utf-8">');
    expect(result.html).toContain('<section class="card" style="padding:8px">');
    expect(result.html).toContain('href="#detail"');
    // External link kept as text, target dropped.
    expect(result.html).toContain('<a href="#">External</a>');
    expect(result.html).toContain('src="data:image/png;base64,AAAA"');
    expect(result.html).toContain('<path d="M0 0L10 10" stroke="currentColor">');
    expect(result.html).toContain('content:"\\2014"');
    expect(result.html).toContain("--ink:#111");
    assertInert(result.html, "legit page");
  });

  test("relative images resolve through the design folder only", () => {
    const resolveAsset = (p: string) => (p === "logo.png" ? { dataUri: "data:image/png;base64,QUJD" } : { error: "file not found in the design folder" });
    const result = prepareHtmlOption('<img src="logo.png"><img src="../secret.png"><div style="background:url(logo.png)">x</div>', { resolveAsset });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.html).toContain('<img src="data:image/png;base64,QUJD">');
    expect(result.html).not.toContain("secret");
    expect(result.html).toContain("background:url(data:image/png;base64,QUJD)");
    expect(result.warnings.some((w) => w.includes("../secret.png"))).toBe(true);
  });

  test("oversized and empty pages are refused", () => {
    expect(prepareHtmlOption("").ok).toBe(false);
    const big = prepareHtmlOption(`<p>${"x".repeat(400_000)}</p>`);
    expect(big.ok).toBe(false);
    if (!big.ok) expect(big.findings[0].rule).toBe("oversized");
  });

  test("previewDocument wraps the sanitized page with the CSP meta first in head", () => {
    const result = prepareHtmlOption(PAGE);
    if (!result.ok) throw new Error("expected ok");
    const doc = previewDocument(result.html);
    const head = doc.indexOf("<head>");
    expect(head).toBeGreaterThan(-1);
    expect(doc.slice(head + "<head>".length)).toMatch(/^<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">/);
  });
});
