# Suzu Design System

Suzu Lives 内部使用的 React 视觉组件工作区。运行时产物 `dist/` 与可编辑源码 `src/` 一并保留，因此根仓库可以在没有外部私有 Git 依赖的情况下安装、构建和打包。

组件源码变更后，从根目录执行：

```powershell
npm run build --workspace=suzu-design-system
```

## Dialog 表层

`Dialog` 的背景、边框/高光、阴影和文字是独立层，不能通过父级 `opacity`
一起调整。新弹窗使用 `surface` 选择完整预设：

- `glass`：默认玻璃层，适合轻量信息。
- `soft`：96% → 90% 的近实心阅读层，适合计划、详情和较长内容。
- `solid`：完全不透明的操作层，适合表单、确认和管理操作。

```tsx
<Dialog open onClose={close} surface="soft" title="标题">
  内容
</Dialog>
```
