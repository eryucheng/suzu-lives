/**
 * Checkpoint wording for Suzu Lives' internal product-use assistant.
 *
 * It retains a user's software goal and the outcome of product actions for
 * a later continuation of the same software task.
 */
export const DEFAULT_SUZU_SOFTWARE_ASSISTANT_COMPACTION_PROMPT = `将这段 Suzu Lives 软件使用助手对话整理为一份可续接的工作记录，供后续说明、导航、配置或软件操作继续使用。

使用简短 Markdown 小节，合并重复内容，保留下一步会用到的已确认事实。按内容选用以下结构：

## 用户目标
用户希望完成的事情与已经确认的完成标准。

## 已确认的情况
已核对的设置、界面状态、模型或能力信息，以及与任务相关的文件位置。

## 已完成的操作
已经执行的页面跳转、设置修改、文件改动和得到的结果。

## 待继续
接下来要做的动作、需要用户补充的信息与当前阻塞点。

保留用户已作出的选择和后续操作所需的具体名称、页面、参数与结果。凭据以“已配置”或“待配置”的状态记录。`;
