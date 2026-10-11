import js from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "web/.next/**",
      "web/public/**",
      "web/next-env.d.ts",
      // 基准测试的 fixtures 和结果目录不是本仓库代码
      "scripts/*/**",
    ],
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    files: [
      "gateway/**/*.{ts,mjs}",
      "shared/**/*.ts",
      "scripts/*.{js,mjs,cjs}",
      "web/**/*.{js,mjs,cjs}",
      "eslint.config.mjs",
    ],
    languageOptions: { globals: globals.node },
  },
  {
    files: ["web/**/*.{ts,tsx}"],
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
  },
  {
    // 只开这两条；v7 recommended 里的 React Compiler 系列规则不开
    files: ["web/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // 存量违规先降为 warn，修完再逐条收紧回 error
    rules: {
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none",
          ignoreRestSiblings: true,
        },
      ],
      // 有意剥控制字符的正则
      "no-control-regex": "warn",
      "no-empty": ["warn", { allowEmptyCatch: true }],
      // 代码里常用 `cond ? a() : b()`、`x && f()` 当语句
      "@typescript-eslint/no-unused-expressions": ["warn", { allowShortCircuit: true, allowTernary: true }],
      "prefer-const": "warn",
    },
  },
);
