import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#0d1117",
        steel: "#161b22",
        ash: "#8b949e",
        signal: "#d29922",
        grid: "#30363d",
      },
      fontFamily: {
        sans: ["Noto Sans TC", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "ui-monospace", "SFMono-Regular", "monospace"],
      },
      boxShadow: {
        panel: "0 0 0 1px rgba(139, 148, 158, 0.12)",
      },
    },
  },
  plugins: [],
} satisfies Config;
