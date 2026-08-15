import type { ReactNode } from 'react';
import styles from './Card.module.css';

export interface CardProps {
  /** 标题（可选） */
  title?: ReactNode;
  /** 副标题说明（可选） */
  description?: ReactNode;
  /** 右上角操作区（可选） */
  action?: ReactNode;
  /** 内边距，默认传 true 使用 token 默认值 */
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Card —— 信息卡片（移植自 .panel）。
 * 可选标题 + 说明 + 右上操作，主体用 content 包裹。
 */
export function Card({
  title,
  description,
  action,
  children,
  className,
  style,
}: CardProps) {
  const cls = [styles.card, className].filter(Boolean).join(' ');

  return (
    <article className={cls} style={style}>
      {title != null && (
        <div className={styles.header}>
          <div className={styles.copy}>
            <h3 className={styles.title}>{title}</h3>
            {description != null && (
              <p className={styles.description}>{description}</p>
            )}
          </div>
          {action != null && <div className={styles.action}>{action}</div>}
        </div>
      )}
      <div className={styles.body}>{children}</div>
    </article>
  );
}
