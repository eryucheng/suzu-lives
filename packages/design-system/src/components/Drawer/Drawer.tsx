import { useEffect, type ReactNode } from 'react';
import styles from './Drawer.module.css';

export type DrawerPlacement = 'left' | 'right';

export interface DrawerProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 出现在哪一侧 */
  placement?: DrawerPlacement;
  /** 标题 */
  title?: ReactNode;
  /** 内容 */
  children?: ReactNode;
}

/**
 * Drawer —— 基于玻璃面板的侧滑抽屉。
 * 受控组件。从左侧或右侧滑入，点击遮罩 / ESC 关闭。
 */
export function Drawer({
  open,
  onClose,
  placement = 'right',
  title,
  children,
}: DrawerProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const cls = [
    styles.drawer,
    placement === 'left' ? styles['placement-left'] : styles['placement-right'],
  ].join(' ');

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <aside
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={cls}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <button
            type="button"
            aria-label="关闭"
            className={styles.close}
            onClick={onClose}
          >
            ×
          </button>
        </div>
        <div className={styles.body}>{children}</div>
      </aside>
    </div>
  );
}
