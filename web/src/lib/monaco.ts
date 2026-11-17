import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";

// Bundled locally (no CDN): editor core + syntax highlighting for all basic languages.
(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
loader.config({ monaco });
monaco.editor.defineTheme("openmax", {
  base: "vs-dark", inherit: true, rules: [],
  colors: { "editor.background": "#0b0c10", "editorGutter.background": "#0b0c10", "editor.lineHighlightBackground": "#14171f", "diffEditor.insertedTextBackground": "#4ade8022", "diffEditor.removedTextBackground": "#f8717122" },
});
export const langFor = (p: string): string => {
  const e = p.split(".").pop()?.toLowerCase() ?? "";
  return ({ ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript", mjs: "javascript", py: "python", rs: "rust", go: "go", java: "java", c: "c", h: "c", cpp: "cpp", rb: "ruby", php: "php", sh: "shell", md: "markdown", json: "json", html: "html", css: "css", scss: "scss", yml: "yaml", yaml: "yaml", sql: "sql", swift: "swift", kt: "kotlin", toml: "ini" } as Record<string, string>)[e] ?? "plaintext";
};
