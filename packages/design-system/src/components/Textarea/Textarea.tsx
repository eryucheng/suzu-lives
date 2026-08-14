import { forwardRef, type TextareaHTMLAttributes } from 'react';
import styles from './Textarea.module.css';

export interface TextareaProps
  extends TextareaHTMLAttributes<HTMLTextAreaElement> {}

/**
 * Textarea —— 多行文本域。透传原生 textarea 属性和 ref。
 * 默认纵向可拉伸（resize: vertical）。
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  function Textarea({ className, style, ...rest }, ref) {
    return (
      <textarea
        ref={ref}
        className={[styles.textarea, className].filter(Boolean).join(' ')}
        style={style}
        {...rest}
      />
    );
  },
);
