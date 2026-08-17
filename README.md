# dsh-command-skill · `/skill` 命令插件

给 DSH Web GUI 的斜杠命令菜单加上 `skill` 功能：

- **`/skill`** —— 打开选择器，自选本会话要优先使用的 skill（再次点击可取消）
- **`/skill import <路径|URL>`** —— 从本地文件/目录或 URL 导入 skill
- **不选择时** —— 所有 skill 照常可被调用（默认行为不变）
- **已选择时** —— 选中的 skill 会被提示给模型优先使用，**没选的 skill 仍可正常调用**（选择只是偏好，不是限制）

## 安装

```powershell
# 1. 把插件链接进 web profile 的 node_modules
New-Item -ItemType Junction -Path "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-command-skill" `
  -Target "C:\Users\Administrator\Documents\dsh-command-skill"

# 2. 在 profile 的 cordis.patch.yml 里 insert：
# - insert:
#     - id: command-skill
#       name: dsh-command-skill

# 3. 重启 dsh web（如 dsh-gui-restart.ps1）
```

## 命令用法

| 命令 | 作用 |
|---|---|
| `/skill` | 打开选择器（弹出所有可用 skill，已选带 ✓ 标记，点击切换） |
| `/skill list` | 文本列出全部 skill 及选择状态 |
| `/skill select <名称…>` | 选择一个或多个 skill 为优先项 |
| `/skill unselect <名称…>` | 取消选择（`deselect` 同义） |
| `/skill clear` | 清空本会话选择 |
| `/skill import <路径\|URL>` | 导入 skill（支持本地 `.md`/`SKILL.md` 目录或 http(s) URL） |

## 说明

- 选择按**会话**保存（`~/.dsh/skill-prefs.json`），重启/恢复会话后仍然生效。
- 导入写入 `~/.dsh/skills/<name>/SKILL.md`（用户级 skill 根目录），内置文件系统提供者会自动发现并广播给模型。
- 注入给模型的只是"优先使用"提醒；`skill` 工具目录始终包含全部可用 skill，未选择的也会被模型按需加载。

## 文件

- `lib/index.js` —— host 端：`/skill` 命令、偏好存储、pre-step 偏好注入、导入
- `lib/client.js` —— 浏览器端：`/skill` 弹出选择器（`command.decorate`）
- `cordis.patch.yml` —— bundle patch（插入插件 roster）
