# 记忆手帐 Memo Journal

> 一个带 AI 助理的个人便签手帐应用。用 Claude Code CLI 作为后端大脑，帮你整理碎碎念、追踪习惯、生成日周摘要、绘制任务关联图谱。

[![在线 Demo](https://img.shields.io/badge/🌐_在线_Demo-点击预览-E8B84B?style=for-the-badge&labelColor=4A3A28)](https://anselkocen.github.io/pls_collect_my_task/)
[![GitHub Release](https://img.shields.io/badge/📦_下载_Mac_App-Releases-4A3A28?style=for-the-badge&labelColor=E8B84B)](https://github.com/AnselKocen/pls_collect_my_task/releases)

> 🌐 **[在线 Demo 预览 →](https://anselkocen.github.io/pls_collect_my_task/)** 不用装任何东西，在浏览器里先逛一圈看看长什么样。Demo 内所有 AI 按钮均为静态模拟，完整功能请走下方安装步骤。

## ✨ 它能帮你做什么

- **随手记录** —— 写下碎碎念、待办、灵感，打标签分类
- **AI 整理思路** —— 让 CC 帮你智能查找、整理标签、生成日/周摘要、绘制任务图谱
- **习惯养成** —— 上传任何书籍 ZIP（饮食、运动、观鸟手册…），生成专属习惯卡池，每天抽一张习惯卡打卡，用可爱胶带贴满日历
- **任务盲盒** —— 任务太多，不知道从何开始？迷茫时随机抽一条待办，让 AI 帮你做决定
- **定时提醒** —— 设置未来时间点，到点系统通知
- **多款主题** —— 提供多种主题色系，支持自定义配色

---

## 🚀 使用方法

### 方法一：下载 Mac 桌面 App（目前仅支持 Mac 用户）

#### 1) 安装前准备：配置 Claude CLI
桌面版首次启动时：
- 如果你已经在终端装过 `claude`，app 会自动检测，无需操作
- 如果没检测到，会弹窗让你手动选 `claude` 可执行文件路径（通常在 `/opt/homebrew/bin/claude`）
- 如果还没登录，在终端运行一次 `claude` 完成登录即可，**不需要重启 app**
- **推荐**启动 app 之前先在终端登录：
  ```bash
  claude
  /login
  ```

#### 2) app下载
👉 **[前往 Releases 下载最新版](https://github.com/AnselKocen/pls_collect_my_task/releases)**

#### 3) 安装
1. 下载最新版的 `.dmg` 文件
2. 双击 dmg，会弹出一个窗口，里面有「记忆手帐」图标和「应用程序」文件夹的快捷方式
3. 把「记忆手帐」图标**拖到**旁边的「应用程序」文件夹里
4. ⚠️ **首次打开会弹窗提示「未打开"记忆手帐"」，这是正常的！** 按以下步骤操作：
   1. 弹窗点**「完成」**（不要点"移到废纸篓"）
   2. 打开 **系统设置 → 隐私与安全性**
   3. 往下滚，找到 **「已阻止"记忆手帐"以保护 Mac」**，点旁边的 **「仍要打开」**
   4. 弹出确认窗口，再次点 **「仍要打开」**，输入密码确认
   5. 之后就能正常使用了，以后不会再拦截

#### 更新版本

重新从 Releases 下载最新 `.dmg`，删除旧的「记忆手帐」app，把新版拖入「应用程序」文件夹即可。数据存储在 `~/Library/Application Support/记忆手帐/data/`，不会因为更新 app 而丢失。如果有重要数据，建议更新前先备份 `data/` 文件夹。

#### 4) 让定时提醒的系统通知长期显示
app 的定时提醒功能依赖 macOS 系统通知。默认情况下，macOS 通知会在几秒后自动消失，很容易错过。建议把它改成「横幅」模式，让通知**一直挂在屏幕右上角直到你手动关闭**：
1. 打开 **系统设置 → 通知**
2. 在应用列表里找到「**记忆手帐**」（首次用过一次通知后才会出现）
3. 点进去，把通知样式从「**临时**」改成「**横幅**」


> ⚠️ 目前app只提供 **Mac ARM64（Apple Silicon）** 版本。Intel Mac 和 Windows 用户请走方式二。

---

### 方式二：Git Clone 运行源码（Mac / Windows / Linux 都支持）

#### 1) 准备环境

a. **Node.js v18+**

检查是否已装，终端/命令行运行：
```bash
node -v
```

有版本号输出（比如 `v20.11.0`）即可。没装的话：
- **Mac**：`brew install node` 或从 https://nodejs.org 下载 LTS 版
- **Windows**：从 https://nodejs.org 下载 LTS 版，或 `winget install OpenJS.NodeJS.LTS`
- **Linux**：`sudo apt install nodejs npm` 或对应发行版的包管理器

b. **Claude Code CLI**（可选，AI 功能需要）

```bash
npm install -g @anthropic-ai/claude-code
```

装完在终端运行一次 `claude` 完成首次登录（需要 Anthropic 订阅或 API Key）。


#### 2) 克隆项目

a. 先在终端/命令行 `cd` 到你想放项目的位置（桌面、某个工作目录、任意盘符都行）。

b. 克隆项目：

```bash
git clone https://github.com/AnselKocen/pls_collect_my_task.git
cd pls_collect_my_task
```

> 克隆会自动创建 `pls_collect_my_task/` 文件夹，所有代码都在里面。

#### 更新版本

在项目目录下执行 `git pull && npm install` 即可。`data/` 文件夹不受 git 管理，更新不会覆盖你的数据。

> ⚠️ 请勿删除整个项目文件夹重新 clone，否则 `data/` 目录会一并丢失。如需备份，先拷贝 `data/` 文件夹。

#### 3) 启动

a. **Mac / Linux：**
```bash
chmod +x start.sh stop.sh
./start.sh       # 启动
./stop.sh        # 停止
```

b. **Windows：**

最简单：在文件资源管理器里**双击 `start.bat`**。
或者在命令行运行：

```cmd
start.bat        REM 启动
stop.bat         REM 停止
```
> ⚠️ 如果你用的是 **PowerShell**（Windows 11 默认终端），需要在前面加 `.\`，例如 `.\start.bat` 和 `.\stop.bat`。

启动后浏览器会自动打开 http://localhost:3013

#### 日常使用（启动 / 停止）
a. **Mac / Linux：**
```bash
cd ~/Desktop/pls_collect_my_task   # 进入你当初克隆的项目目录
./start.sh                         # 启动
```
b. **Windows：**

直接**双击** `start.bat`，或者：
```powershell
cd C:\你\项目的\路径\pls_collect_my_task
.\start.bat
```

> 启动后浏览器会自动打开 http://localhost:3013。如果没自动打开，手动在浏览器里输入这个地址即可。

#### 关于终端窗口和停止服务

启动脚本会把服务放到后台运行，**可以关闭启动时的终端窗口**，服务会继续运行。
想停止服务时，即使之前启动的终端已经关了也没关系，**打开一个新的终端/命令行**，重新进入项目目录运行停止命令即可：

**Mac / Linux：**

```bash
cd ~/Desktop/pls_collect_my_task   # 进入项目目录（替换成你实际的路径）
./stop.sh
```

**Windows：**

```cmd
REM 进入项目目录（替换成你实际的路径）
cd %USERPROFILE%\Desktop\pls_collect_my_task
stop.bat
```

如果 `stop.sh` / `stop.bat` 不起作用，可以直接按端口杀进程作为兜底：
```bash
# Mac / Linux
lsof -ti :3013 | xargs kill
```

```cmd
:: Windows
for /f "tokens=5" %a in ('netstat -ano ^| findstr ":3013 " ^| findstr "LISTENING"') do taskkill /PID %a /F
```

> ⚠️ Windows 小注意：直接点窗口右上角 × 关闭命令行有小概率连带停止后台服务，推荐用 `stop.bat` 正常停止。

---

## 📚 功能介绍

### 📝 便签管理
- 快速记录、编辑、删除、置顶
- 自定义标签 + emoji + 胶带样式
- 标签筛选、关键词搜索
- 看板视图按标签分组展示

### 🤖 智能助手（需要 Claude Code CLI）- 注意⚠️：使用cc时需要正确的科学上网环境
- **智能查找** —— 输入你想找的东西，AI 从所有便签里找出最相关的
- **整理标签** —— AI 分析便签，建议合并或新增标签
- **任务图谱** —— 可视化展示便签之间的关联关系
- **今日摘要** —— 每天 23:55 自动汇总最近两天的手帐（也可手动触发）
- **本周总结** —— 每周日 23:59 自动生成一周深度总结与标签趋势（也可手动触发）

### 🌻 特色玩法
- **习惯养成** —— 上传书籍 ZIP（饮食、运动、观鸟手册等），AI 从书里生成习惯卡池，每天抽一张打卡，填满打卡日历
- **任务盲盒** —— 选几个标签，随机抽一条待办，让 AI 帮你做决定
- **定时提醒** —— 设置未来日期+时间，到点系统通知

### 🎨 主题配色
- 多款预设主题
- 自定义配色
- 每个标签可单独设置 emoji 和胶带样式

---

## ❓ 常见问题

### Q：点 AI 按钮没反应，按钮闪一下就恢复了，也没弹窗

**大概率是 Claude Code CLI 没登录，或登录态过期了。**

解决：

1. 打开终端
2. 运行 `claude`（或 `/opt/homebrew/bin/claude`）
3. 按提示完成登录
4. 回到 app 重试。如果仍然不行，关闭服务后重新启动（源码版运行 `stop.sh` / `stop.bat`，再 `start.sh` / `start.bat`）

怎么确认是这个问题？按 `Cmd+Option+I` 打开 DevTools → Console，再点一次 AI 按钮，如果看到 `CC 调用失败` 或 `Claude exited with code ...` 之类，基本就是登录问题。

### Q：点「生成」按钮后没有内容生成，或者结果是空的

**和上一个问题同根同源 —— 通常都是 Claude CLI 没登录或登录过期了。**

最快的解决办法：

1. 打开终端（Mac/Linux）或命令提示符（Windows）
2. 直接运行：
   ```bash
   claude
   ```
3. 按提示重新登录一次（已经登录过的话会直接显示欢迎信息，没登录会引导你去网页认证）
4. 登录完成后，回到 app 或浏览器，点一下「重新生成」就行。如果仍然不行，关闭服务后重新启动（源码版运行 `stop.sh` / `stop.bat`，再 `start.sh` / `start.bat`）

> 这个问题很常见，因为 Claude CLI 的登录态有时候会自动过期。如果某天突然发现 AI 功能"没反应"，第一反应应该就是重新跑一遍 `claude` 看看登录状态。

### Q：今日摘要/本周总结没有自动生成

**自动生成需要 app 在对应时间点处于运行状态。**

- 今日摘要：每天 23:55 触发（可在设置里改）
- 本周总结：每周日 23:59 触发

如果那一刻 app 没开，就会错过那次自动触发。你可以随时手动点「重新生成」补上。

### Q：AI 操作要多久才出结果？

取决于 Claude 模型的响应速度和你的便签数量，通常 **5-30 秒**。期间 CC 会显示"正在思考"状态。

⚠️ **CC 一次只能做一件事**，正在跑一个 AI 任务时其他 AI 按钮会提示"CC 正在忙，等它忙完吧~"

### Q：升级新版 app 后，之前的数据还在吗？

**在。** 数据目录：

- **Mac 桌面 App**：`~/Library/Application Support/记忆手帐/data/`，覆盖安装不会动这个目录
- **Mac / Linux 源码运行版**：项目根目录下的 `data/` 文件夹
- **Windows 源码运行版**：项目根目录下的 `data\` 文件夹

想备份数据？直接拷贝对应的 `data` 文件夹即可。

### Q：我想改每日摘要的时间

在设置面板里可以改「每日整理时间」。本周总结时间（周日 23:59）目前是固定默认值，需要手动改 `data/settings.json` 里的 `weeklyDigestDay` 和 `weeklyDigestTime`。

### Q：不想用 AI 功能也能用吗？

可以。没有 Claude CLI 的话，便签管理、标签筛选、搜索、看板、主题切换、定时提醒这些功能都能正常用，只是智能助手和习惯养成的部分功能会不可用。

---

## 📜 协议

GPL-3.0 + 非商用附加条款，详见 [LICENSE](LICENSE)

未经作者书面许可，不得将本软件用于商业用途。注意：本项目的非商用限制是在 GPL-3.0 基础上的额外约束。

## 作者

Anselkocen
