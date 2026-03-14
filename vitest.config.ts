import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
  },
  resolve: {
    // Allow vitest to resolve .js extensions to .ts source files
    extensions: [".ts", ".js"],
  },
});
