/** @type {import('tailwindcss').Config} */

// Tylix Flux design tokens.
//
// One accent (crimson) and one neutral scale. Pages written over the years
// use zinc, stone, slate, neutral and gray interchangeably; all five point at
// the same `ink` scale below so every screen reads as one product without
// rewriting thousands of class names. Change a value here and it changes
// everywhere.

const ink = {
    50: "#f7f7f8",
    100: "#efeff1",
    200: "#e3e3e6",
    300: "#cacacf",
    400: "#9d9da6",
    500: "#75757e",
    600: "#56565d",
    700: "#3a3a40",
    800: "#232327",
    900: "#151517",
    950: "#0c0c0d",
};

const crimson = {
    50: "#fef3f2",
    100: "#fde4e3",
    200: "#fbcdcb",
    300: "#f6a8a6",
    400: "#f0676b",
    500: "#e0393f",
    600: "#c92d33",
    700: "#a8242a",
    800: "#8b2126",
    900: "#731f23",
    950: "#3f0b0e",
};

export default {
    darkMode: "class",
    content: ["./app/**/*.tyx", "./public/app-shell.js"],
    theme: {
        extend: {
            colors: {
                tylix: {
                    blue: crimson[500],
                    orange: crimson[400],
                },
                brand: crimson,
                ink,
                zinc: ink,
                stone: ink,
                slate: ink,
                neutral: ink,
                gray: ink,
                // Surfaces. These switch between light and dark through the
                // CSS variables in app/tailwind-input.css, so no dark: prefix
                // is needed.
                page: "var(--page)",
                panel: "var(--panel)",
                raised: "var(--raised)",
                sunken: "var(--sunken)",
                line: "var(--line)",
                "line-strong": "var(--line-strong)",
                fg: "var(--fg)",
                muted: "var(--muted)",
            },
            fontFamily: {
                sans: ["Geist", "Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
                mono: ["Geist Mono", "ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "monospace"],
            },
            boxShadow: {
                card: "0 1px 0 0 rgb(255 255 255 / 0.03) inset, 0 1px 2px 0 rgb(0 0 0 / 0.04)",
                pop: "0 24px 60px -12px rgb(0 0 0 / 0.45), 0 0 0 1px rgb(255 255 255 / 0.06)",
            },
            keyframes: {
                "loader-slide": {
                    "0%": { transform: "translateX(-100%)" },
                    "100%": { transform: "translateX(400%)" },
                },
                "loader-fade": {
                    from: { opacity: "0" },
                    to: { opacity: "1" },
                },
                "loader-ring": {
                    "0%": { transform: "scale(0.9)", opacity: "0.6" },
                    "100%": { transform: "scale(1.7)", opacity: "0" },
                },
                "flux-in": {
                    from: { opacity: "0", transform: "translateY(4px) scale(0.985)" },
                    to: { opacity: "1", transform: "none" },
                },
                "flux-sheet": {
                    from: { transform: "translateY(16px)", opacity: "0" },
                    to: { transform: "none", opacity: "1" },
                },
                "flux-pulse": {
                    "0%, 100%": { opacity: "1" },
                    "50%": { opacity: "0.35" },
                },
            },
            animation: {
                "loader-slide": "loader-slide 1.4s ease-in-out infinite",
                "loader-fade": "loader-fade 0.3s ease 0.2s both",
                "loader-ring": "loader-ring 1.8s ease-out infinite",
                "flux-in": "flux-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
                "flux-sheet": "flux-sheet 220ms cubic-bezier(0.2, 0.8, 0.2, 1) both",
                "flux-pulse": "flux-pulse 1.6s ease-in-out infinite",
            },
        },
    },
    plugins: [],
};
