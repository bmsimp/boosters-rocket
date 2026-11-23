import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Static design references, not app code.
    "design/**",
    // Git worktrees for agents working in parallel: each is linted from inside itself.
    ".worktrees/**",
    // Tiptap's Simple Editor template, kept as its CLI copies it so upstream updates merge cleanly
    // (src/app/components/tiptap/README.md): typechecked, not held to our lint rules. Our wrapper is linted.
    "src/app/components/tiptap/**",
  ]),
]);

export default eslintConfig;
