import type { ReactNode } from 'react';
import styles from './Roster.module.css';

export interface RosterProps {
  /** 头像（推荐用 Avatar 组件） */
  avatar: ReactNode;
  /** 名称 */
  name: ReactNode;
  /** 副标题（如最近一句 / 身份） */
  subtitle?: ReactNode;
  /** 右侧 meta（如在线状态徽章 / 时间） */
  meta?: ReactNode;
  /** 是否选中（高亮底 + 描边） */
  selected?: boolean;
  /** 点击回调 */
  onClick?: () => void;
  className?: string;
}

/**
 * Roster —— 成员 / 会话列表项。组合 Avatar + 名称 + 可选副标题与右侧 meta。
 * selected 高亮选中态。
 */
export function Roster({
  avatar,
  name,
  subtitle,
  meta,
  selected = false,
  onClick,
  className,
}: RosterProps) {
  const cls = [styles.row, selected && styles.rowActive, className]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={cls} onClick={onClick} aria-pressed={selected}>
      <span className={styles.avatar}>{avatar}</span>
      <span className={styles.copy}>
        <span className={styles.name}>{name}</span>
        {subtitle != null && <span className={styles.subtitle}>{subtitle}</span>}
      </span>
      {meta != null && <span className={styles.meta}>{meta}</span>}
    </button>
  );
}
