import styles from './Status.module.css';

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'muted';

export interface StatusProps {
  /** 文字标签 */
  label: string;
  /** 状态色调（决定圆点与文字颜色、底色） */
  tone?: StatusTone;
}

/**
 * Status —— 状态徽章，带前置状态圆点。
 * 5 档色调：success / warning / danger / info / muted。
 */
export function Status({ label, tone = 'muted' }: StatusProps) {
  return (
    <span className={[styles.pill, styles[`tone-${tone}`]].join(' ')}>
      {label}
    </span>
  );
}
