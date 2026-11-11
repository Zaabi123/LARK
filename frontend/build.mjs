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
await writeFile("dist/config.js", `window.APP_CONFIG = ${JSON.stringify({ apiUrl })};\n`);
console.log(`Built dist/ (API_URL=${apiUrl || "not set"})`);
