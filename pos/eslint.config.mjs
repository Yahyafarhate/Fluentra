import next from "eslint-config-next";

const config = [
  ...next,
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
  {
    rules: {
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/purity": "off",
      "react-hooks/immutability": "off",
      "@next/next/no-img-element": "off",
      "@next/next/no-location-assign-relative-destination": "off", // full reload after login/logout is intentional (fresh cookie + state)
    },
  },
];

export default config;
