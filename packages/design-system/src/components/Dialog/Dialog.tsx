import { useEffect, type ReactNode } from 'react';
import styles from './Dialog.module.css';

/**
 * Dialog 的表层预设。
 *
 * - glass: 默认玻璃层，适合轻量信息。
 * - soft: 接近实心的阅读层，保留细微的表层层次。
 * - solid: 完全不透明的操作层，适合表单、确认和管理操作。
 */
export type DialogSurface = 'glass' | 'soft' | 'solid';

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
  /**
   * 表层样式。背景、边框、高光、阴影和文字层由组件成套处理，
   * 不要通过父级 opacity 一起调低，避免文字也随之发灰。
   */
  surface?: DialogSurface;
}

/**
 * Dialog —— 基于玻璃面板的居中弹窗。
 * 受控组件：open/onClose 由外部管理。支持 ESC 关闭、点击遮罩关闭。
 */
export function Dialog({ open, onClose, title, children, footer, surface = 'glass' }: DialogProps) {
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
        className={[styles.dialog, styles[`surface-${surface}`]].join(' ')}
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
