// Builds the web app from src/ into dist/ (no dependencies, Node 26 LTS; see .nvmrc).
//   dist/index.html            the app (installable PWA, works offline after the first visit)
//   dist/fsd.html              the same page without <html>/<head> (for embedding)
//   dist/manifest.webmanifest, dist/sw.js, dist/icon.svg, dist/icons/, dist/screenshots/
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
// output folder: dist/ by default, or `--out docs` for the ready-built copy GitHub Pages can serve directly
const outArg = process.argv.indexOf("--out");
const dist = join(root, outArg > 0 ? process.argv[outArg + 1] : "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// error explanations of V1–V5 as one JSON object { "Error 11": "..." }
const errors = {};
for (const name of readdirSync(join(src, "errors")).filter((f) => f.endsWith(".txt")).sort()) {
  errors[name.replace(/\.txt$/, "")] = readFileSync(join(src, "errors", name), "utf8");
}
const json = JSON.stringify(errors).replace(/<\//g, "<\\/");

const page = readFileSync(join(src, "app.html"), "utf8")
  .replace("/*CORE*/", () => readFileSync(join(src, "core.js"), "utf8"))
  .replace("/*ERRORS*/{}", () => json);
writeFileSync(join(dist, "fsd.html"), page);

// <title> and <meta> at the top of app.html belong in <head> of the standalone page
const headTags = [];
const body = page.replace(/^\s*((?:<title>[^<]*<\/title>|<meta [^>]*>)\s*)+/, (m) => {
  headTags.push(m.trim());
  return "";
});

const index = `<!doctype html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
${headTags.join("\n")}
<meta name="description" content="Diagnose van de PLC96 front- en deursturing via de seriële kabel">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="FSD">
<link rel="manifest" href="manifest.webmanifest">
<link rel="icon" href="icon.svg" type="image/svg+xml">
<link rel="icon" href="icons/icon-192.png" type="image/png" sizes="192x192">
<link rel="apple-touch-icon" href="icons/apple-touch-icon.png">
</head>
<body>
${body}
</body>
</html>
`;
writeFileSync(join(dist, "index.html"), index);

copyFileSync(join(src, "manifest.webmanifest"), join(dist, "manifest.webmanifest"));
copyFileSync(join(src, "icon.svg"), join(dist, "icon.svg"));
cpSync(join(src, "icons"), join(dist, "icons"), { recursive: true });
cpSync(join(src, "screenshots"), join(dist, "screenshots"), { recursive: true });

// service worker: precache every file of the app, new cache name per build so phones update
const files = ["./", "./index.html", "./manifest.webmanifest", "./icon.svg",
  ...readdirSync(join(dist, "icons")).map((f) => "./icons/" + f)];
const version = createHash("sha256").update(index).update(files.join()).digest("hex").slice(0, 10);
const sw = readFileSync(join(src, "sw.js"), "utf8")
  .replace(/const CACHE = "[^"]*";/, `const CACHE = "fsd-${version}";`)
  .replace(/const FILES = \[[^\]]*\];/, `const FILES = ${JSON.stringify(files)};`);
writeFileSync(join(dist, "sw.js"), sw);

console.log(`built ${dist.slice(root.length + 1)}/ (version ${version}, ${Math.round(index.length / 1024)} kB, ${files.length} files cached offline)`);
