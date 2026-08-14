import type { CSSProperties, ElementType, ReactNode } from 'react';
import styles from './GlassPanel.module.css';

export type GlassIntensity = 'subtle' | 'soft' | 'prominent';

export interface GlassPanelProps {
  /** 根元素标签，默认 div */
  as?: ElementType;
  /** 玻璃强度 */
  intensity?: GlassIntensity;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

/**
 * 玻璃面板 —— 静态渐变模拟的磨砂玻璃容器。
 *
 * 依赖背后的底色才能呈现质感，因此通常放在渐变 / 图片 / 深色背景上使用。
 * 实现为半透明渐变 + 高光描边 + 柔影，暗色下比实时 blur 更稳、更可控。
 */
export function GlassPanel({
  as: Tag = 'div',
  intensity = 'soft',
  className,
  style,
  children,
}: GlassPanelProps) {
  const cls = [styles.panel, styles[`intensity-${intensity}`], className]
    .filter(Boolean)
    .join(' ');
  return (
    <Tag className={cls} style={style}>
      {children}
    </Tag>
  );
}
