import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";

import "suzu-design-system/style.css";
import "./styles.css";
import "./react/app-shell.css";
import { AppShell } from "./react/app-shell.jsx";

const app = document.querySelector("#app");

if (!app) throw new Error("缺少应用外壳挂载点。");

const root = createRoot(app);

flushSync(() => root.render(<AppShell />));

void import("./app.mjs");
