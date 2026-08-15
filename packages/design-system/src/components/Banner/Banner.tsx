import type { ReactNode } from 'react';
import styles from './Banner.module.css';

export type BannerTone = 'warning' | 'info' | 'danger' | 'success' | 'neutral';

export interface BannerProps {
  /** 色调，默认 neutral */
  tone?: BannerTone;
  /** 前置图标（可选） */
  icon?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Banner —— 内联通知条。低透明度底色 + 同色系文字 / 描边。
 * 用于页面内提示通知（区别于弹窗类 toast）。
 */
export function Banner({
  tone = 'neutral',
  icon,
  children,
  className,
  style,
}: BannerProps) {
  const cls = [styles.banner, styles[`tone-${tone}`], className]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} style={style} role={tone === 'danger' ? 'alert' : 'status'}>
      {icon != null && <span className={styles.icon}>{icon}</span>}
      <div className={styles.body}>{children}</div>
    </div>
  );
}
