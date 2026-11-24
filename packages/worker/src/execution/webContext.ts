import { extractUrls, type WebClient } from "@/tools/webClient";

/**
 * Fetch referenced URLs through the shared Stagehand browser and render them
 * as a compact "Web context" block for read-only agents.
 * ponytail: 3 URLs / 8k chars each; raise limits or page-range follow the
 * links if a research task needs deeper crawling.
 */
export async function buildWebContext(
  browser: WebClient | undefined,
  text: string
): Promise<{ block: string; fetched: string[]; failed: string[] }> {
  const urls = extractUrls(text).slice(0, 3);
  if (!browser || urls.length === 0) return { block: "", fetched: [], failed: [] };

  const fetched: string[] = [];
  const failed: string[] = [];
  const pages = await Promise.allSettled(
    urls.map(async (url) => {
      const result = await browser.fetch(url);
      return {
        url: result.url,
        title: result.title,
        content: result.content.replace(/\s+/g, " ").trim().slice(0, 8000),
      };
    })
  );

  const sections: string[] = [];
  pages.forEach((page, index) => {
    const target = urls[index];
    if (page.status === "fulfilled") {
      fetched.push(target);
      sections.push(
        `### ${page.value.title || page.value.url}\n${page.value.url}\n${page.value.content}`
      );
    } else {
      failed.push(target);
    }
  });

  if (sections.length === 0) return { block: "", fetched, failed };
  return {
    block: `Web context (live browser fetch):\n${sections.join("\n\n")}`,
    fetched,
    failed,
  };
}
