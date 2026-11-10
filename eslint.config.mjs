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
  ]),
  {
    files: ["src/core/**/*.ts", "**/*.test.ts", "scripts/**/*.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // Server components render once per request, so reading the clock there is correct (the purity rule targets client re-renders).
    files: ["src/app/**/*.{ts,tsx}", "src/ui/**/*.{ts,tsx}"],
    rules: { "react-hooks/purity": "off" },
  },
  {
    ignores: ["**/*.test.ts"],
    files: ["src/modules/**/*.{ts,tsx}", "src/app/**/*.{ts,tsx}", "src/ui/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [{ name: "mongodb", importNames: ["MongoClient"], message: "Use tenantCol() from @/core/db." }],
        patterns: [{ group: ["**/core/db/client"], message: "Raw db access is banned outside src/core. Use tenantCol()/withTransaction()." }],
      }],
      "no-restricted-syntax": ["error", {
        selector: "ImportSpecifier[imported.name=/^(getDb|getClient)$/]",
        message: "Raw collection access is banned outside src/core. Use tenantCol().",
      }],
    },
  },
]);

export default eslintConfig;
