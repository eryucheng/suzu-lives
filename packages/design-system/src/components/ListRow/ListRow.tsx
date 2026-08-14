import type { ReactNode } from 'react';
import styles from './ListRow.module.css';

export interface ListRowProps {
  /** 前置图标（可选） */
  icon?: ReactNode;
  /** 主标题 */
  title: ReactNode;
  /** 副标题说明（可选） */
  description?: ReactNode;
  /** 右侧操作区（箭头等，自动右对齐） */
  action?: ReactNode;
  /** 是否可交互（高亮 hover 背景） */
  interactive?: boolean;
  /** 行点击回调 */
  onClick?: () => void;
  className?: string;
}

/**
 * ListRow —— 列表行。图标 + 标题/说明 + 右侧操作。
 * 可交互时渲染为按钮，否则为静态容器。
 */
export function ListRow({
  icon,
  title,
  description,
  action,
  interactive = true,
  onClick,
  className,
}: ListRowProps) {
  const cls = [styles.row, interactive && styles.interactive, className]
    .filter(Boolean)
    .join(' ');

  const Tag = interactive ? 'button' : 'div';
  return (
    <Tag
      type={interactive ? 'button' : undefined}
      className={cls}
      onClick={interactive ? onClick : undefined}
    >
      {icon != null && <span className={styles.icon}>{icon}</span>}
      <span className={styles.copy}>
        <span className={styles.title}>{title}</span>
        {description != null && (
          <span className={styles.description}>{description}</span>
        )}
      </span>
      {action != null && <span className={styles.action}>{action}</span>}
    </Tag>
  );
}
