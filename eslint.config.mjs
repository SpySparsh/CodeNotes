import nextConfig from "eslint-config-next/core-web-vitals";

const eslintConfig = [
  {
    ignores: [
      ".next/**",
      "temp_app/**",
      "node_modules/**",
      "baseline/**",
      "grafana/**",
      "prometheus/**",
    ],
  },
  ...nextConfig,
];

export default eslintConfig;
