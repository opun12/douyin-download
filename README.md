# douyin-download

把抖音视频**整段**下载到本地：无水印直链、带音轨、带时长校验（不会只拿到前几秒的预览小片）。

不依赖任何第三方解析站，也不依赖 `yt-dlp`——它在本地启动一个真实 Chromium 打开抖音视频页，让页面自己完成风控验证，再从播放器网络请求里取出该视频的完整 mp4 直链。

```
$ node scripts/douyin-dl.mjs "3.21 xyz:/ 复制打开抖音 https://v.douyin.com/xxxx/"
=== https://www.douyin.com/video/7412xxxxxxxxxxxxx
✅ ~/Downloads/抖音视频/作者_文案_7412xxxxxxxxxxxxx.mp4
   28.56 MB · 319.8s / 页面 319.8s · 含音轨(已合并 aac)
```

---

## 为什么需要它

抖音网页把视频拆成 DASH 分离流，并且播放器默认**静音**——不解除静音，页面根本不会去请求音轨。于是常见的两条路都不好用：

| 方案 | 问题 |
|---|---|
| `yt-dlp` 的抖音提取器 | 需要 `a_bogus` 签名，抖音改版后基本失效 |
| 各种在线解析站 | 广告、限画质、常挂；视频要经过别人服务器 |
| 录屏 | 有界面、有水印、重编码掉画质 |
| 直接抓 `video.currentSrc` | **只有画面没有声音**（音轨是另一条流） |

本工具的做法：真实浏览器过验证 → 抓播放器直链 → `ffprobe` 校验时长是否等于页面时长（不等就换下一个候选直链重下）→ 检测到无音轨则单独拉 `media-audio` 流，用 `ffmpeg -c copy` 无损封装回单文件。

## 特性

- **无水印**：取的是播放器源直链，不是页面上那层水印画面
- **完整时长**：下载后与页面 `video.duration` 比对（≥90% 才收），避免拿到预览小片
- **自动补音轨**：DASH 分离流场景下自动拉音频流并无损合并
- **幂等**：同名文件已存在且合格则跳过；旧文件无音轨会自动重下
- **批量**：一次传多条链接
- **登录态持久化**：Cookie 存在用户目录下，需要更高清晰度时用 `--headed` 手动登录一次即可

## 环境要求

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 18 | 需要内置 `fetch` 与 ESM |
| Chrome / Edge / Chromium | 任一即可，脚本会自动探测；也可用 `CHROME_PATH` 指定 |
| `ffmpeg` + `ffprobe` | 需要在 `PATH` 里。用于时长校验与音轨合并 |

`ffprobe` / `ffmpeg` 缺失时下载仍会进行，但无法校验完整性与合并音轨，效果等同于上面表格里的"只有画面"方案。

## 安装

```bash
git clone https://github.com/opun12/douyin-download.git
cd douyin-download
npm install
```

Windows 也可以直接双击 `download.bat`（粘链接回车即可）。

## 用法

```bash
# 最简：粘整段分享口令都行
node scripts/douyin-dl.mjs "https://v.douyin.com/xxxx/"

# 指定输出目录
node scripts/douyin-dl.mjs --out "D:/素材" "https://v.douyin.com/xxxx/"

# 显示浏览器窗口（首次使用 / 排查风控时）
node scripts/douyin-dl.mjs --headed "https://v.douyin.com/xxxx/"

# 批量
node scripts/douyin-dl.mjs "链接1" "链接2" "链接3"
```

| 参数 | 作用 |
|---|---|
| `--out <dir>` | 输出目录，默认 `~/Downloads/抖音视频` |
| `--headed` | 显示浏览器窗口，便于手动过验证 / 登录 |

**支持的输入**：`v.douyin.com` 短链、`www.douyin.com/video/<id>`、`?modal_id=<id>`、以及包含链接的整段分享口令文本（`3.21 xyz:/ 复制打开抖音 https://... 看看`）。

**输出命名**：`<作者>_<文案>_<视频ID>.mp4`（文案会做文件名净化，截断到 50 字）。

**退出码**：`0` 全部成功 · `1` 启动失败/参数错误 · `2` 有链接下载失败。

## 工作原理

1. `fetch` 跟随重定向把短链展开成 `https://www.douyin.com/video/<id>`
2. `puppeteer-core` 拉起本机 Chrome，打开视频页，监听 `response` 事件，从 `douyinvod` / `bytevcloud` / `bytecdn` / `amemv` 域名里分离出**视频流**与**音频流**直链
3. 轮询 `video.readyState ≥ 2 且 duration > 1` 确认播放器真正就绪，再强制 `muted = false; play()` 促使页面拉音频流
4. 按「播放器当前正在用的 → 体积降序」依次尝试下载，`ffprobe` 比对时长；通过后若无音轨则拉音频流 `ffmpeg -map 0:v:0 -map 1:a:0 -c copy` 封装

## 常见问题

**`页面没吐出视频直链`**
视频已删除/私密/付费，或触发了风控验证。先加 `--headed` 打开窗口手动过一次验证与登录，再重试。

**下载下来的文件没有声音**
`ffprobe` 不在 PATH，或页面没给出音频流。先确认 `ffprobe -version` 能跑；再试 `--headed` 让播放器真正出声。

**`找不到 Chrome / Edge / Chromium`**
装一个 Chrome，或指定路径：

```bash
# Windows (Git Bash)
CHROME_PATH="/c/Program Files/Google/Chrome/Application/chrome.exe" node scripts/douyin-dl.mjs "链接"
# macOS / Linux
CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" node scripts/douyin-dl.mjs "链接"
```

**`找不到 puppeteer-core`**
没执行 `npm install`，或从别的目录调用了脚本。也可用 `PUPPETEER_BASE=/path/to/package.json` 指向已有安装。

**想要更高清晰度**
匿名一般拿到 720p–1080p。用 `--headed` 登录一次后，清晰度上限取决于账号与视频源，Cookie 会保留在 `~/.cache/douyin-dl-profile`。

## 已知限制

- 只支持**视频**；图文 / 图集（`/note/`）走视频路径会失败
- 不支持直播流、付费、私密、已删除内容
- 输出多为 HEVC(H.265)，播放器不兼容时需自行转码
- 抖音风控与接口会变，脚本可能需要跟着更新
- 仅做了 Windows 实测；macOS / Linux 的浏览器探测路径已写好但未逐一验证

## 免责声明

本项目仅供**个人学习、研究与素材备份**使用。请遵守抖音的用户协议与相关法律法规，尊重原作者版权：

- 不要用于批量搬运、二次分发或商业盗用
- 转载/引用他人作品请先获得授权并注明出处
- 由使用本工具产生的一切后果由使用者自行承担

本项目不含任何绕过付费或 DRM 的能力，也不提供任何解析服务端。

## License

[MIT](LICENSE)
