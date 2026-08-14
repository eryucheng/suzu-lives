import type { ReactNode } from 'react';
import styles from './Empty.module.css';

export interface EmptyProps {
  /** 前置符号（推荐 22px 描边 svg，自动上色） */
  icon?: ReactNode;
  /** 标题 */
  title: ReactNode;
  /** 说明文字 */
  description?: ReactNode;
  /** 底部操作（如按钮，自动居中） */
  action?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Empty —— 空状态占位（移植自 .empty-panel）。
 * 居中排布符号 + 标题 + 说明 + 可选操作。
 */
export function Empty({
  icon,
  title,
  description,
  action,
  className,
  style,
}: EmptyProps) {
  return (
    <div className={[styles.panel, className].filter(Boolean).join(' ')} style={style}>
      {icon != null && <div className={styles.symbol}>{icon}</div>}
      <h3 className={styles.title}>{title}</h3>
      {description != null && (
        <p className={styles.description}>{description}</p>
      )}
      {action != null && <div className={styles.action}>{action}</div>}
    </div>
  );
}
