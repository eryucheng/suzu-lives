import type { ReactNode } from 'react';
import styles from './Tabs.module.css';

export interface TabItem {
  label: ReactNode;
  value: string;
  /** 可选前置图标 */
  icon?: ReactNode;
}

export interface TabsProps {
  items: TabItem[];
  /** 当前激活项 value（受控展示态） */
  active?: string;
  /** 切换回调，回传选中项 value */
  onChange?: (value: string) => void;
  size?: 'sm' | 'md' | 'lg';
  fullWidth?: boolean;
  className?: string;
}

/**
 * Tabs —— 分段页签（移植自 .admin-tabs）。外层圆角底 + 内凹，
 * 激活项紫色描边 + 淡紫底。可横向滚动，active 为当前展示态。
 */
export function Tabs({
  items,
  active,
  onChange,
  size = 'sm',
  fullWidth = false,
  className,
}: TabsProps) {
  const cls = [
    styles.tabs,
    fullWidth && styles.fullWidth,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls} role="tablist">
      {items.map((it) => {
        const isActive = it.value === active;
        return (
          <button
            key={it.value}
            type="button"
            role="tab"
            aria-selected={isActive}
            className={[
              styles.tab,
              styles[`size-${size}`],
              isActive && styles.tabActive,
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => onChange?.(it.value)}
          >
            {it.icon}
            {it.label}
          </button>
        );
      })}
    </div>
  );
}
