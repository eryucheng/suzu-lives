import "./page-scaffold.css";

function joinClassNames(...names) {
  return names.filter(Boolean).join(" ");
}

/**
 * 页面骨架：
 * - 页面骨架统一承接标题栏和内容区的滚动。
 * - 内容区是独立的可编排画布，只负责卡片边缘留白与布局。
 */
export function PageScaffold({
  canvasClassName = "",
  children,
  className = "",
  header,
}) {
  return (
    <div className="page-layout">
      <div className={joinClassNames("page-layout__frame", className)}>
        <div className="page-titlebar">{header}</div>
        <div className={joinClassNames("page-canvas", canvasClassName)}>{children}</div>
      </div>
    </div>
  );
}
