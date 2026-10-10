# 运行与接入

需要 Node.js 20.9 或更高版本，支持 macOS、Linux、Windows。首选宿主注入 PATH 的 Node.js；运行 `node --version` 检查。没有宿主运行时时，使用标准 Node.js 安装，不用技能修改系统配置。

Windows 可直接调用 `scripts/run.ps1`，它会先查当前 PATH，再找用户目录下 WorkBuddy 托管的 Node.js。macOS/Linux 可调用 `bash scripts/run.sh`。调用时传递原命令及参数：

```powershell
& "<技能目录>\scripts\run.ps1" doctor
& "<技能目录>\scripts\run.ps1" setup --registry https://registry.npmmirror.com
& "<技能目录>\scripts\run.ps1" generate --input "C:\图片\参考图.png" --out "C:\作品\新建六档图纸"
```

```bash
bash "<技能目录>/scripts/run.sh" generate --input "/path/photo.png" --out "/path/new-result"
```

默认依赖缓存为用户目录 `.cache/bead-pattern/` 下按版本、系统、架构分开的目录。`BEAD_PATTERN_CACHE` 可指定独立缓存；不要与不可信包共享。依赖固定为 sharp 0.34.5、pdf-lib 1.17.1、fflate 0.8.2。setup 通过 npm 下载必要依赖，转换和重新导出不访问网络。

setup 使用包内锁文件和 npm ci 固定传递依赖，不需要管理员权限，不安装系统全局包，不修改系统 PATH。若镜像不可用，省略 `--registry` 使用 npm 默认配置。未安装依赖且断网时说明缺少依赖，不伪造生成结果。网络安装最多重试一次，仍失败时报告原因。

Windows 入口以带 BOM 的 UTF-8 保存，同时兼容系统自带 Windows PowerShell 5.1 和 PowerShell 7。setup 优先调用 npm 的 JS 入口；托管运行时只有 PATH 中的 npm/npm.cmd 包装器时，先检查版本，再通过该包装器安装，可支持实际 npm 位于 ASAR 的宿主。若宿主完全不提供可执行 npm，使用附带 npm 的 Node.js 安装后重试；不要尝试直接让普通 Node 读取 npm.asar。

图纸固定文字使用 JSON 矢量字形：PNG 直接绘制字形路径，PDF 使用带 Unicode 映射的矢量字形。不携带 TTF、OTF 等字体文件，不依赖宿主中文字体。相关授权声明保留在独立许可文件中，不参与对话输出。

大图色号 PNG 按 192 像素高的条带无损输出，每格仍为 24 像素；PDF 按页压缩矢量内容，避免为全部格子同时保留绘图对象。遇到内存不足保留已完成档位，用原图和新目录单独重跑失败档位。

通用宿主：将整个 `bead-pattern` 文件夹放入宿主技能目录。WorkBuddy：在技能页面导入市场版原始 ZIP，或放入宿主支持的本地技能目录；不要再套一层压缩包。导入成功仍需检查运行依赖。

运行成功和平台市场审核通过是两件事；市场包不包含会员、支付、第三方生图或外部图库。
