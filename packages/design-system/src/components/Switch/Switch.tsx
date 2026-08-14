import { forwardRef, type InputHTMLAttributes } from 'react';
import styles from './Switch.module.css';

export interface SwitchProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'children'> {
  /** 是否开启（受控） */
  checked: boolean;
}

/**
 * Switch —— 开关。隐藏原生 checkbox + 视觉 track/thumb。
 * 受控组件：checked / onChange 由外部管理。
 */
export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  function Switch({ checked, className, ...rest }, ref) {
    return (
      <label className={[styles.switch, className].filter(Boolean).join(' ')}>
        <input ref={ref} type="checkbox" checked={checked} {...rest} />
        <span className={styles.track} />
      </label>
    );
  },
);
