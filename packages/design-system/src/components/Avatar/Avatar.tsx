import type { ReactNode } from 'react';
import styles from './Avatar.module.css';

export type AvatarSize = 'sm' | 'md' | 'lg' | 'xl';

export interface AvatarProps {
  /** 图片地址；缺失或加载失败时退回首字母 */
  src?: string;
  /** 名称，用于取首字母作为回退图 */
  name: string;
  /** 尺寸 */
  size?: AvatarSize;
  /** 替代首字母的占位内容（如图标） */
  fallback?: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * Avatar —— 头像。渐变紫底 + 圆角 + 柔影。
 * 有 `src` 时显示图片；否则显示 `name` 的首字母（退回大写）。
 */
export function Avatar({
  src,
  name,
  size = 'md',
  fallback,
  className,
  style,
}: AvatarProps) {
  const initial = String(name).trim().slice(0, 1).toUpperCase();
  const cls = [styles.avatar, styles[`size-${size}`], className]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={cls} style={style} aria-label={name} role="img">
      {src ? (
        <img src={src} alt="" draggable={false} />
      ) : (
        <span className={styles.initial}>{fallback ?? initial}</span>
      )}
    </span>
  );
}
