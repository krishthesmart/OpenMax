// Bundles React for the sandboxed artifact iframe so React artifacts render offline.
import { build } from "esbuild";
import fs from "node:fs";
fs.mkdirSync("public/vendor", { recursive: true });
fs.writeFileSync("public/vendor/_entry.js", `import * as React from "react";import * as jsx from "react/jsx-runtime";import { createRoot } from "react-dom/client";export { React, jsx, createRoot };`);
await build({ entryPoints: ["public/vendor/_entry.js"], bundle: true, format: "esm", minify: true, outfile: "public/vendor/react-bundle.js", define: { "process.env.NODE_ENV": '"production"' }, logLevel: "error" });
fs.rmSync("public/vendor/_entry.js");
