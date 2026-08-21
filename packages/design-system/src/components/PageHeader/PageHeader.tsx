import type { ReactNode } from 'react';
import styles from './PageHeader.module.css';

export interface PageHeaderProps {
  /** 顶部小字标签（如功能分区名） */
  eyebrow?: ReactNode;
  /** 大标题 */
  title: ReactNode;
  /** 副标题说明 */
  subtitle?: ReactNode;
  /** 右侧操作区（按钮等），可选 */
  action?: ReactNode;
  className?: string;
}

/**
 * PageHeader —— 页面顶部标题区。
 * 布局：eyebrow 小字 + 大标题 + 副标题居左，右侧可放操作按钮。
 */
export function PageHeader({
  eyebrow,
  title,
  subtitle,
  action,
  className,
}: PageHeaderProps) {
  return (
    <div className={[styles.header, className].filter(Boolean).join(' ')} data-suzu-page-header>
      <div className={styles.copy}>
        {eyebrow != null && <div className={styles.eyebrow}>{eyebrow}</div>}
        <h1 className={styles.title}>{title}</h1>
        {subtitle != null && <p className={styles.subtitle}>{subtitle}</p>}
      </div>
      {action != null && <div className={styles.action}>{action}</div>}
    </div>
  );
}
