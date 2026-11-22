import { builtinModules } from "node:module";
import esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  // Obsidian gives these modules to the plugin.
  external: [
    "obsidian",
    "electron",
    "@codemirror/*",
    "@lezer/*",
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
  ],
  format: "cjs",
  target: "es2022",
  sourcemap: watch ? "inline" : false,
  logLevel: "info",
  outfile: "main.js",
});

if (watch) {
  await context.watch();
} else {
  await context.rebuild();
  await context.dispose();
}
