export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        cinder: {
          50: "#f7f8f9",
          100: "#eef1f3",
          200: "#dbe2e8",
          300: "#c8d0d8",
          400: "#96a6b3",
          500: "#617485",
          600: "#405565",
          700: "#253847",
          800: "#1c2c38",
          900: "#14202a",
        },
        pine: {
          100: "#def0ea",
          300: "#85c3a7",
          500: "#2f8f68",
          700: "#1f6349",
        },
        ember: {
          100: "#ffe9d8",
          300: "#f4bb88",
          500: "#de7b2d",
        },
        signal: {
          100: "#ffe2e0",
          300: "#ef9891",
          500: "#d55044",
        },
      },
      boxShadow: {
        float: "0 28px 80px rgba(20, 32, 42, 0.12)",
      },
      fontFamily: {
        display: ["Trebuchet MS", "Segoe UI", "sans-serif"],
      },
    },
  },
  plugins: [],
};
