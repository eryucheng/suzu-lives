import { useEffect, type ReactNode } from 'react';
import styles from './Dialog.module.css';

export interface DialogProps {
  /** 是否打开 */
  open: boolean;
  /** 关闭回调（点遮罩、ESC、关闭按钮触发） */
  onClose: () => void;
  /** 标题 */
  title?: ReactNode;
  /** 正文内容 */
  children?: ReactNode;
  /** 底部操作区 */
  footer?: ReactNode;
}

/**
 * Dialog —— 基于玻璃面板的居中弹窗。
 * 受控组件：open/onClose 由外部管理。支持 ESC 关闭、点击遮罩关闭。
 */
export function Dialog({ open, onClose, title, children, footer }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        className={styles.dialog}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {title != null && (
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
        )}
        <div className={styles.body}>{children}</div>
        {footer != null && <div className={styles.footer}>{footer}</div>}
      </div>
    </div>
  );
}
