# 可选本地图像模型的来源与许可

权重下载地址、固定 revision、大小和 SHA-256 的唯一运行时清单是 [`src/adapters/local-image-models.ts`](../../src/adapters/local-image-models.ts)。本目录只保存许可和来源材料，不包含权重，不执行上游代码。`sources.json` 记录本目录原文的精确下载 URL 和 SHA-256。

- **Depth Anything V2 Small**：上游为 DepthAnything/Depth-Anything-V2，Small 模型采用 Apache-2.0。本目录 `depth-anything-v2-LICENSE` 是官方提交 `a561b849ebae10a6f5ef49e26c83cbbcd36c71bf` 的原始 LICENSE。使用的 ONNX 来自 `onnx-community/depth-anything-v2-small-ONNX` 的固定 revision `c3b67641fd837b2368757101311e5d21e511441e`，该版本模型卡原文为 `depth-onnx-MODEL_CARD.md`，声明 Apache-2.0。
- **MobileSAM**：上游为 ChaoningZhang/MobileSAM，Apache-2.0；`mobilesam-LICENSE` 是官方提交 `f706ad9c4eb7f219c00d9050e46328518ffb65d2` 的原始 LICENSE。使用的 ONNX 来自 Acly/MobileSAM 的固定 revision `0d3b403339b4674a82493d5e97964dd78089ddc8`，该模型卡原文为 `mobilesam-onnx-MODEL_CARD.md`，声明 MIT 并链接上游和转换来源。

Acly 的该固定版本没有独立 LICENSE 文件；这里完整保留其模型卡原始声明，没有自行拟造带版权人的 MIT 许可证。转换仓库的 MIT 元数据不替代 MobileSAM 上游 Apache-2.0 条款。发布审查应保留这一来源差异，必要时向转换发布者确认其单独许可文本。

上游源码提交在这里用于固定许可原文，不表示已独立重现 ONNX 转换或证明它与某一上游源码提交逐位对应。Ediro 不修改这些权重，只在本地转换输入和输出图像。
