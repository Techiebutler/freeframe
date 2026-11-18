import nextCoreWebVitals from "eslint-config-next/core-web-vitals";

// Flat config. Next 16 removed `next lint` and ESLint 9 only reads this format.
const eslintConfig = [
  ...nextCoreWebVitals,
  {
    // eslint-plugin-react-hooks 7 (pulled in by eslint-config-next 16) adds
    // React Compiler rules that report as errors. The codebase predates them,
    // so they stay visible as warnings until the existing hits are cleaned up.
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/refs": "warn",
      "react-hooks/immutability": "warn",
      "react-hooks/static-components": "warn",
      "react-hooks/globals": "warn",
    },
  },
  {
    // Test doubles render a plain <a> in place of next/link.
    files: ["**/__tests__/**"],
    rules: {
      "@next/next/no-html-link-for-pages": "off",
    },
  },
  {
    ignores: [
      ".next/**",
      "node_modules/**",
      "out/**",
      "build/**",
      "coverage/**",
      "next-env.d.ts",
    ],
  },
];

export default eslintConfig;
