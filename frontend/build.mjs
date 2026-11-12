// Builds the static dashboard into dist/ for Vercel. No dependencies.
// API_URL (the Railway backend URL) comes from the environment (Vercel → Settings → Environment Variables)
// or from .env.local. If it's missing, the page still works: you type the URL on the page.
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

let apiUrl = process.env.API_URL || "";
if (!apiUrl) {
  try {
    apiUrl = (await readFile(".env.local", "utf8")).match(/^API_URL=(.*)$/m)?.[1].trim() ?? "";
  } catch {}
}
apiUrl = apiUrl.replace(/\/+$/, "");
if (apiUrl && !/^https?:\/\//.test(apiUrl)) {
  console.error(`API_URL must start with https:// (got "${apiUrl}").`);
  process.exit(1);
}
if (!apiUrl) console.warn("API_URL is not set: the dashboard will ask for the backend URL.");

await rm("dist", { recursive: true, force: true });
await mkdir("dist");
await copyFile("index.html", "dist/index.html");
// Security headers for Cloudflare Pages (Vercel uses vercel.json, Render uses render.yaml).
await writeFile(
  "dist/_headers",
  "/*\n  X-Content-Type-Options: nosniff\n  X-Frame-Options: DENY\n  Referrer-Policy: no-referrer\n/config.js\n  Cache-Control: no-cache\n",
);
// Better Stack browser logs (optional). The source token can only send logs, so it's safe in the page.
const logtailToken = (process.env.BETTERSTACK_SOURCE_TOKEN || "").trim();
const logtailHost = (process.env.BETTERSTACK_HOST || "").trim().replace(/\/+$/, "");
const logtail = logtailToken && logtailHost
  ? { token: logtailToken, endpoint: /^https?:\/\//.test(logtailHost) ? logtailHost : `https://${logtailHost}` }
  : null;

await writeFile("dist/config.js", `window.APP_CONFIG = ${JSON.stringify({ apiUrl, logtail })};\n`);
console.log(`Built dist/ (API_URL=${apiUrl || "not set"}, Better Stack logs: ${logtail ? "on" : "off"})`);
