import ReactDOM from "react-dom/client";

import App from "./App";
import "./index.css";

function syncViewportHeight() {
  const viewportHeight = Math.max(window.innerHeight, window.visualViewport?.height ?? 0);
  document.documentElement.style.setProperty("--app-dvh", `${Math.round(viewportHeight)}px`);
}

syncViewportHeight();

window.addEventListener("resize", syncViewportHeight);
window.visualViewport?.addEventListener("resize", syncViewportHeight);
window.addEventListener("orientationchange", syncViewportHeight);
window.addEventListener("pageshow", syncViewportHeight);

ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("Service worker registration failed", error);
    });
  });
}
