# MJ 蜘蛛侠彩蛋

这是一个独立的渲染器彩蛋模块。应用窗口内任意位置连续键入 `mj` 后，会立即随机播放一套蜘蛛侠透明动画及对应声音；无需按回车。动画层不接收鼠标事件，重复触发会从新的一次播放开始。

## 接入与移除

唯一运行时接入点是 `apps/control-center/src/main.jsx` 中对本目录 `index.mjs` 的导入。移除彩蛋时：

1. 删除该导入行。
2. 删除整个 `easter-eggs/mj-spiderman` 目录。
3. 删除 `apps/control-center/test/mj-spiderman-easter-egg.test.mjs`。

模块不使用 Electron IPC、不修改应用状态，也不依赖 React 页面结构。
