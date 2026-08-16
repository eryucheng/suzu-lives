import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import styles from './Select.module.css';

export interface SelectOption {
  label: string;
  value: string;
}

export interface SelectProps {
  /** 选项列表 */
  options: SelectOption[];
  /** 受控当前值 */
  value?: string;
  /** 非受控初始值 */
  defaultValue?: string;
  /** 选中回调，回传选中项的 value */
  onChange?: (value: string) => void;
  /** 无值时的占位文案 */
  placeholder?: string;
  disabled?: boolean;
  /** 撑满容器宽度（默认固定 220px） */
  fullWidth?: boolean;
  /** a11y 关联 label 的 id */
  id?: string;
  /** 没有可关联 <label> 时提供的可访问名称 */
  ariaLabel?: string;
  className?: string;
}

/**
 * Select —— 自绘毛玻璃下拉，不用浏览器原生弹层。
 * 受控/非受控皆可。面板为玻璃底 + 淡入动画，点击外部 / ESC / 上下键关闭。
 */
export function Select({
  options,
  value,
  defaultValue,
  onChange,
  placeholder = '请选择',
  disabled = false,
  fullWidth = false,
  id,
  ariaLabel,
  className,
}: SelectProps) {
  const [open, setOpen] = useState(false);
  // 非受控时的内部值；受控时忽略
  const [uncontrolled, setUncontrolled] = useState(defaultValue ?? '');
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = value !== undefined ? value : uncontrolled;
  const current = options.find((o) => o.value === selected);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // 打开时重置高亮到当前选中项
  useEffect(() => {
    if (open) setActiveIndex(options.findIndex((o) => o.value === selected));
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectOne = useCallback(
    (val: string) => {
      setOpen(false);
      setActiveIndex(-1);
      if (value === undefined) setUncontrolled(val);
      onChange?.(val);
    },
    [value, onChange],
  );

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    if (disabled) return;
    if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (!open) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((i) =>
        ((i < 0 ? -dir : i) + dir + options.length) % options.length,
      );
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      selectOne(options[activeIndex].value);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(options.length - 1);
    }
  };

  const wrapperCls = [
    styles.wrapper,
    fullWidth && styles.fullWidth,
    disabled && styles.disabled,
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div ref={rootRef} className={wrapperCls}>
      <button
        id={id}
        type="button"
        className={[styles.trigger, open && styles.open].filter(Boolean).join(' ')}
        onClick={() => !disabled && setOpen((v) => !v)}
        onKeyDown={handleKeyDown}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        disabled={disabled}
      >
        {current ? (
          <span className={styles.label}>{current.label}</span>
        ) : (
          <span className={styles.placeholder}>{placeholder}</span>
        )}
        <svg
          className={[styles.chevron, open && styles.chevronOpen]
            .filter(Boolean)
            .join(' ')}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && !disabled && (
        <div className={styles.panel} role="listbox">
          {options.map((opt, i) => {
            const isSelected = opt.value === selected;
            return (
              <button
                key={opt.value}
                type="button"
                role="option"
                aria-selected={isSelected}
                className={[
                  styles.option,
                  isSelected && styles.selected,
                  i === activeIndex && styles.active,
                ]
                  .filter(Boolean)
                  .join(' ')}
                onClick={() => selectOne(opt.value)}
                onMouseEnter={() => setActiveIndex(i)}
              >
                {opt.label}
                <svg
                  className={styles.check}
                  viewBox="0 0 16 16"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M3 8.5L6.5 12 13 4.5"
                    stroke="currentColor"
                    strokeWidth="1.8"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
