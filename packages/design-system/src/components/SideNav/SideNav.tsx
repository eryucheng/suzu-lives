import type { ReactNode } from 'react';
import styles from './SideNav.module.css';

export interface SideNavProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

/**
 * SideNav —— 侧边导航容器。纵向排列一组 SideNavItem。
 */
export function SideNav({ children, className, style }: SideNavProps) {
  return (
    <nav className={[styles.nav, className].filter(Boolean).join(' ')} style={style}>
      {children}
    </nav>
  );
}

export interface SideNavItemProps {
  /** 是否激活（左侧竖条 + 渐变底） */
  active?: boolean;
  /** 前置图标（推荐内联 19px 的 svg，自动描边） */
  icon?: ReactNode;
  /** 激活 / 点击回调 */
  onClick?: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * SideNavItem —— 单个导航项。hover 淡紫底，active 左侧竖条 + 横向渐变。
 */
export function SideNavItem({
  active = false,
  icon,
  onClick,
  children,
  className,
}: SideNavItemProps) {
  const cls = [
    styles.item,
    active && styles.itemActive,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      type="button"
      className={cls}
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
    >
      {icon != null && <span className={styles.icon}>{icon}</span>}
      <span className={styles.label}>{children}</span>
    </button>
  );
}
