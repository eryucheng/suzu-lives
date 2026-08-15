import { forwardRef, type InputHTMLAttributes, type ReactNode } from 'react';
import styles from './Input.module.css';

export type InputSize = 'sm' | 'md' | 'lg';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** 前置内容（如图标） */
  prefix?: ReactNode;
  /** 后置内容（如按钮） */
  suffix?: ReactNode;
  size?: InputSize;
}

/**
 * Input —— 文本输入框。
 * 透传原生 input 属性和 ref；可选 prefix / suffix 内嵌内容与尺寸变体。
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(
  function Input(
    { prefix, suffix, size = 'md', className, style, ...rest },
    ref,
  ) {
    const cls = [
      styles.input,
      styles[`size-${size}`],
      prefix != null && styles['has-prefix'],
      suffix != null && styles['has-suffix'],
      className,
    ]
      .filter(Boolean)
      .join(' ');

    return (
      <span className={styles.wrapper} style={style}>
        {prefix != null && (
          <span className={[styles.affix, styles.prefix].join(' ')}>
            {prefix}
          </span>
        )}
        <input ref={ref} className={cls} {...rest} />
        {suffix != null && (
          <span className={[styles.affix, styles.suffix].join(' ')}>
            {suffix}
          </span>
        )}
      </span>
    );
  },
);
