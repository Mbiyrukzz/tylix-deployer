/** @type {import('tailwindcss').Config} */
export default {
    darkMode: "class",
    content: ["./app/**/*.tyx"],
    theme: {
        extend: {
            colors: {
                tylix: {
                    blue: "#8b5cf6",
                    orange: "#e879f9",
                },
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
            },
            animation: {
                "loader-slide": "loader-slide 1.4s ease-in-out infinite",
                "loader-fade": "loader-fade 0.3s ease 0.2s both",
                "loader-ring": "loader-ring 1.8s ease-out infinite",
            },
        },
    },
    plugins: [],
};