# iPhone 快捷指令能力

这个目录提供两个方向的能力：

- `send_to_iphone.py`：主动请求 iPhone 快捷指令执行操作；
- `receive_from_iphone.py`：由后台监听器接收手机反馈，不需要 Agent 自己启动。

## 主动操作 iPhone

在项目根目录运行：

```powershell
python "scripts/abilities/connect_iphone/send_to_iphone.py" "主题" "内容"
```

主题和正文必须符合用户在 iPhone 快捷指令中的约定。例如：

```powershell
python "scripts/abilities/connect_iphone/send_to_iphone.py" "闹钟" "08:30 起床"
python "scripts/abilities/connect_iphone/send_to_iphone.py" "查岗" ""
```

不要自行创造手机没有配置的主题。命令输出“已发送”只表示邮件已经交给邮箱服务器，手机是否执行仍取决于网络和对应快捷指令。

## 接收手机反馈

监听器会按 `feedback_config.json` 中的主题映射，把手机邮件正文送入当前 Agent 会话。默认示例使用 `{{content}}`，即正文原样成为提示词。

收到手机反馈后，把它当作当前现实信息正常理解和回应。不要再次运行 `receive_from_iphone.py`，也不要重复创建后台监听器。
