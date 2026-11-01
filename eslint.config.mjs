// JavaScript (ESM): ESLint flat config. eslint-config-next 16 ships flat
// presets only, so the legacy .eslintrc.json cannot load them. ESLint 8.57
// picks this file up and ignores .eslintrc.json, which stays for upstream.
import coreWebVitals from 'eslint-config-next/core-web-vitals';
import typescript from 'eslint-config-next/typescript';

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'build/**',
      'data/**',
      'drizzle/**',
      'next-env.d.ts',
      '.claude/**',
    ],
  },
  ...coreWebVitals,
  ...typescript,
];

export default config;
