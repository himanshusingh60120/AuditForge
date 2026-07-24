import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0d1117",
        panel: "#161c24",
        edge: "#242e3a",
        steel: "#8b98a9",
        forge: "#f59f45",
        ember: "#e2543a",
        verdant: "#4cc38a",
        cobalt: "#5b9dd9",
      },
      fontFamily: {
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
      },
    },
  },
  plugins: [],
};
export default config;
