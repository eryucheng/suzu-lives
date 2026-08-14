/**
 * tokens/colors.ts
 * 颜色设计令牌 —— 设计系统的单一事实源。
 *
 * 原则：
 * - 以「语义」命名（—bg, —text, —accent…），不使用「页面/设备」命名，便于跨端迁移。
 * - 主题通过 CSS 变量注入（暗色优先，亮色覆盖在 [data-theme="light"]）。
 * - 本文件导出 JS 常量供组件/Storybook 使用；CSS 变量在 themes.css 中引用。
 */

/** 品牌主色（紫）—— 源自 Suzu Lives 现有审美，经现代化微调 */
export const brand = {
  50: '#f0efff',
  100: '#e0dcff',
  200: '#c4bcff',
  300: '#a196ff',
  400: '#8b82ff',
  500: '#7a6dff',
  600: '#6657ef',
  700: '#5548cf',
  800: '#443b9e',
  900: '#2f2a6b',
  950: '#1d1a42',
} as const;

/** 强调辅助色（青绿）—— 与紫形成互补的高级组合 */
export const accent = {
  50: '#e6fbf6',
  100: '#c2f2ea',
  200: '#8de7d8',
  300: '#59d9c4',
  400: '#33c7ae',
  500: '#1ea993',
  600: '#178576',
  700: '#136a5e',
  800: '#0f5047',
  900: '#0b3a34',
} as const;

/** 中性灰阶 —— 用于背景、边框、文字层级 */
export const neutral = {
  0: '#ffffff',
  50: '#f5f7fb',
  100: '#eef0f6',
  200: '#dce1ec',
  300: '#c2c9da',
  400: '#97a1bc',
  500: '#6b7592',
  600: '#4a526d',
  700: '#363c53',
  800: '#24283a',
  900: '#161a29',
  950: '#0c0f1c',
} as const;

/** 功能色：成功 / 警告 / 错误 / 信息 */
export const status = {
  success: '#34c98a',
  warning: '#f2b05e',
  danger: '#f26b8e',
  info: '#4da6ff',
} as const;

/** 圆角色阶 */
export const radius = {
  none: '0px',
  sm: '6px',
  md: '10px',
  lg: '14px',
  xl: '20px',
  pill: '999px',
} as const;

/** 间距刻度（4px 基准） */
export const space = {
  xs: '4px',
  sm: '8px',
  md: '12px',
  lg: '16px',
  xl: '24px',
  '2xl': '32px',
  '3xl': '48px',
} as const;

/** 字号刻度 */
export const fontSize = {
  xs: '11px',
  sm: '12px',
  md: '13px',
  lg: '14px',
  xl: '16px',
  '2xl': '20px',
  '3xl': '27px',
} as const;

/** 字重 */
export const fontWeight = {
  regular: 400,
  medium: 500,
  semibold: 600,
  bold: 700,
} as const;

/** 阴影（暗色主题下的柔和分层） */
export const shadow = {
  sm: '0 1px 2px rgba(0,0,0,.25), 0 1px 3px rgba(0,0,0,.18)',
  md: '0 4px 12px rgba(0,0,0,.28), 0 2px 4px rgba(0,0,0,.20)',
  lg: '0 12px 28px rgba(0,0,0,.35), 0 4px 8px rgba(0,0,0,.22)',
} as const;

/**
 * 毛玻璃（Glassmorphism）—— 采用「静态渐变模拟」，不用实时 backdrop blur。
 *
 * 为什么不用真 blur：
 * - 设计系统暗色优先，深背景下真模糊易灰度不均、糊成一团，且大面积实时模糊耗性能。
 * - 静态做法 = 半透明渐变底 + 高光描边 + 柔影，对比度完全可控、不依赖背后内容。
 *
 * 若未来要在照片背景上做真模糊，可启用 --glass-backdrop 的 blur()。
 */
export const glass = {
  bg: 'linear-gradient(160deg, rgba(255,255,255,0.08), rgba(255,255,255,0.02))',
  border: 'rgba(255,255,255,0.14)',
  backdrop: '8px',
  shadow: '0 12px 32px rgba(0,0,0,0.40), 0 2px 6px rgba(0,0,0,0.25)',
} as const;

/** 亮色主题下的玻璃 token（覆盖值，见 themes.css [data-theme='light']） */
export const glassLight = {
  bg: 'linear-gradient(160deg, rgba(255,255,255,0.72), rgba(255,255,255,0.45))',
  border: 'rgba(255,255,255,0.85)',
  backdrop: '8px',
  shadow: '0 12px 32px rgba(30,30,60,0.18), 0 2px 6px rgba(30,30,60,0.12)',
} as const;
