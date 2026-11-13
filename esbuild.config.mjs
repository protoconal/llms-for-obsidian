import esbuild from "esbuild";
import sveltePlugin from "esbuild-svelte";

await esbuild.build({
  entryPoints: ["src/main.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["obsidian", "sqlite-vec"],
  conditions: ["svelte", "browser"],
  mainFields: ["svelte", "browser", "module", "main"],
  plugins: [sveltePlugin({ compilerOptions: { css: "injected" } })],
  outfile: "main.js"
});
