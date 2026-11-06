import { WebClient } from "./src/tools/webClient";

async function main() {
  const client = new WebClient({ headless: true, timeoutMs: 30_000, maxContentLength: 2_000 });

  const result = await client.fetch("https://github.com");
  console.log("FETCH url:", result.url);
  console.log("FETCH title:", result.title);
  console.log("FETCH statusCode:", result.statusCode);
  console.log("FETCH content:", result.content.replace(/\s+/g, " ").slice(0, 160));
  console.log("FETCH links:", result.links.slice(0, 5));
  console.log("FETCH images:", result.images.slice(0, 5));

  const shot = await client.screenshot("https://github.com");
  console.log("SCREENSHOT bytes:", shot.length, "base64Len:", Buffer.from(shot).toString("base64").length);

  const search = await client.search("browser automation agent", 3);
  console.log("SEARCH results:", JSON.stringify(search).slice(0, 600));

  await client.close();
  console.log("LIVE_BROWSER_SMOKE_OK");
}

main().catch((error) => {
  console.error("LIVE_BROWSER_SMOKE_FAIL", error);
  process.exit(1);
});
