# Suzu Design System

Suzu Lives 内部使用的 React 视觉组件工作区。运行时产物 `dist/` 与可编辑源码 `src/` 一并保留，因此根仓库可以在没有外部私有 Git 依赖的情况下安装、构建和打包。

组件源码变更后，从根目录执行：

```powershell
npm run build --workspace=suzu-design-system
```
