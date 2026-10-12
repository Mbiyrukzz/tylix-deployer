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
    },
  },
  plugins: [],
};