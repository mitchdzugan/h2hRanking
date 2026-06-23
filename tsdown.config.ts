import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: ["./src/cli.js"],
    hash: false,
    format: ["esm"],
    fixedExtension: true,
    clean: true,
    minify: true,
    deps: { alwaysBundle: /.*dz.*/ },
  },
]);
