import "./mj-spiderman.css";
import hangingSpidermanUrl from "./media/spiderman-hang.webm?url";
import swingingSpidermanUrl from "./media/spiderman-swing.webm?url";
import { installMjSpidermanEasterEgg } from "./runtime.mjs";

const uninstallMjSpidermanEasterEgg = installMjSpidermanEasterEgg({
  effects: [
    {
      id: "hanging",
      label: "倒挂蜘蛛侠",
      src: hangingSpidermanUrl,
    },
    {
      id: "swinging",
      label: "荡蛛丝蜘蛛侠",
      src: swingingSpidermanUrl,
    },
  ],
});

if (import.meta.hot) import.meta.hot.dispose(uninstallMjSpidermanEasterEgg);

export { uninstallMjSpidermanEasterEgg };
