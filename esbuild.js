// esbuild.js
const esbuild = require("esbuild");

esbuild.build({
  entryPoints: ["src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  outfile: "dist/extension.js",
  sourcemap: true,
  external: ["vscode"],
}).catch(() => process.exit(1));
