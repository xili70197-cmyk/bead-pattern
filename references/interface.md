# 命令与工程

命令以 UTF-8 输出 JSON。generate/render 退出码 0 表示完整成功，1 表示输入/执行错误或部分档位失败，doctor 退出码 2 表示缺少依赖。start/status 返回 0 表示该命令成功执行；必须读取 JSON status 判断后台任务是否完成。generate 的进度 JSON 写入 stderr；默认用 start/status 避免宿主缓存输出。

## 命令

| 命令 | 参数 | 行为 |
|---|---|---|
| doctor | 无 | 只读检查版本、资源和固定依赖 |
| setup | `--registry HTTPS地址`（可选） | 安装到技能专属缓存 |
| start | `--input`、`--out` 必填 | 后台生成，立即返回；支持 generate 的可选参数 |
| status | `--out`，可选 `--after`、`--wait-ms` | 查询真实进度和已完成文件；最多等待 10000 ms |
| cancel | `--out` | 当前步骤结束后停止，保留完整档位 |
| generate | `--input`、`--out` 必填 | 从原图生成多个规格、总览、统计和 ZIP |
| render | `--pattern`、`--out` 必填 | 从 v1 工程重新导出该矩阵 |

generate 可选参数：

- `--sizes 29,48,100,200,300,500`：默认全部六档；接受 1～12 个不重复的 4～500 整数，各档按长边计算。
- `--max-colors 16`：默认 16，允许 1～41。
- `--brightness 100`、`--contrast 100`、`--saturation 100`：0～200。
- `--sharpness 0`：0～100；`--hue 0`：-180～180。

只接受静态 PNG/JPEG/WebP，文件上限 50 MB、原图上限 4000 万像素。保留照片方向信息的实际朝向，并转到 sRGB。输出目录必须为空，不能位于技能安装目录。

## 输出

目录 `029-grid` 等按长边格数命名；每档文件名含实际宽高。每档包含色号图纸 PNG、打印 PDF、清单 CSV、工程 `.bead.json`、无色号预览 PNG。

根目录包含 `规格对比总览.png`、`全部规格统计.csv`、`manifest.json`、`拼豆图纸-全部规格.zip`。总览只用于比较；制作时下载对应档位的色号图纸。

start 另创建 .bead-job 任务状态目录，不打入图纸 ZIP。状态查询、事件及用户通知规则见 [进度与等待](progress.md)。manifest 的 finalizing 表示总览或打包仍在处理；打包失败标记 partial 和 finalizationError，只有真实存在的根文件才出现在 files 中。

stdout 的最终 JSON 提供绝对文件路径；manifest 内保存相对路径，解压后可以移植。`variants` 含 `size/w/h/status/colorCount/totalBeads/recommendedBeads/stats/files`。部分失败会含 `error`，其余已完成档位仍可使用。每档完成后立即写 manifest，意外中断也可查看已完成档位。

## 工程兼容

工程使用原网站 v1 字段：`version:1`、`id`、`name`、`w`、`h`、`cells`、`updated`、`settings`。cells 为行优先扁平数组，`-1` 为空格，其他数字为原网站 Hama 41 色表的索引；顺序不变。

新增 `paletteId` 与 `conversion` 元数据，记录长边、源图片 SHA256、适应方式、透明阈值和算法版本。原网站忽略额外字段，可导入继续编辑。render 同时接受不含 paletteId 的旧网站工程；明确声明其他色卡版本的工程拒绝导入。工程不嵌入原图，无法仅凭工程恢复原始照片细节。

PDF 每页最多 32×32 格，5.5 mm 打印单元，行列坐标全局连续；最后一页为统计。PNG 每格 24 像素，空格用淡灰短线区分白色豆子，底部附用量。备料按各色分别 `ceil(count × 1.1)`，合计不等于总豆数乘 1.1 后的一次取整。
