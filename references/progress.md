# 进度与等待

默认通过短命令 start/status 执行，让 Agent 在任务运行时有机会向用户说话。后台进程按档顺序处理原图，不需要网页服务器。任务未结束时保持处理，最终再交付全部结果。

```text
node "<技能目录>/scripts/bead.cjs" start --input "图片.png" --out "新目录"
node "<技能目录>/scripts/bead.cjs" status --out "同一目录" --after 0 --wait-ms 5000
```

第一次查询 after 为 0，随后取上次响应的 cursor。出现新事件、任务结束或最多等待 5 秒后返回；返回后先通知用户，再继续查询。5 秒等待结束不是任务失败。start/status 的执行工具超时可以设为 20 秒；首次 setup 单独留足时间。

## 响应

- status：starting、running、cancelling 为进行中；complete、partial、failed、cancelled 为终态。complete 表示各档、总览和 ZIP 全部完成。
- completedSizes、completedCount、total：已完成档位和总档数。各档完成次数不是耗时百分比。
- current：当前实际阶段、格数和人类可读 message。phase 为 input、convert、chart、pdf、overview、archive 等。
- events：上次游标后的新进度，最多返回最近 40 条。variant-complete 带实际宽高、颜色数、总豆数和五个文件的绝对路径；此事件发出前文件已写完。
- variants：保留已完成或失败档位。即使错过事件，也可从该列表找文件；记录已通知的 size，避免重复。
- files：总览、汇总和 ZIP 路径，按真实完成情况出现。终态 result 包含完整 generate 结果和详细统计。
- elapsedMs、updatedAgoMs：实际经过时间；大图计算时不会持续产生事件，不能据此推算剩余时间。

## 对用户的交代

查询得到新完成档位就发进度，不等全部完成。一次查询发现三档都完成，可合并：“29、48、100 格都已完成，下面先看 29 格预览；正在处理 200 格。”提供第一档 preview 图片及 chart/pdf 下载链接。

大图耗时超过 10～15 秒时说明实际阶段；阶段改变时优先说明变化，例如“500 格的色号图已完成，正在制作分页 PDF。”只有完成事件才说该档生成完毕；总览与 ZIP 也需要时间，分别说明。不展示游标、PID、NDJSON 等内部术语，不编造进度比例，不抄写原始 JSON。

## 停止和异常

用户明确要求停止：`cancel --out "同一目录"`。取消是协作式的，当前缩放、配色或导出步骤完成后检查请求，可能不会立即停止。继续查询到 cancelled，展示已有完整档位。半成品不得当完整图纸交付。

进程意外退出会被 status 检测为 failed。展示 variants 中已完成的文件，读取 diagnosticLog 诊断，不重复启动全部档位。单档失败用原图和新目录重跑该档。总览或打包失败时 partial 和 result.finalizationError 说明原因，不能声称 ZIP 已交付。输出目录 .bead-job 仅用于恢复和诊断，不进入客户图纸 ZIP。
