# 漫画测试样本

这些文件只用于 `reader/comic` 与 HTTP 端点测试，均为本地生成的小样本，不含第三方版权内容。

- `page1.jpg`、`page2.jpg`、`page10.jpg`：320×200、400×200、3200×1800 的纯色 JPEG，用于验证自然排序、screen 长边限制与 original 字节不变。
- `transparent.png`：600×300 透明 PNG，用于验证 screen 透明像素铺白。
- `huge.png`：8000×5000 纯色 PNG（40M 像素，小于 1 亿索引上限但超过 original 的 32M 上限）。
- `comic_rar4.rar` / `comic_rar5.rar`：RAR4/RAR5 非固实归档，条目顺序为 page1、page2、page10。
- `comic_solid_rar4.rar` / `comic_solid_rar5.rar`：RAR4/RAR5 固实归档，条目顺序为 page1、page10、page2，用于验证顺序解码与按页缓存。
- `comic_encrypted_rar5.rar`：仅文件数据加密（密码 `secret`），用于验证加密拒绝。
- `comic_multi.part1.rar` / `comic_multi.part2.rar`：分卷 RAR，用于验证多卷明确不支持。
- `comic_symlink_rar5.rar`：包含符号链接条目，用于验证符号链接拒绝。
- `comic_traversal.rar`：条目名为 `../page1.jpg`，用于验证路径穿越拒绝。

生成方式（本机测试环境）：

```sh
# 用 RAR 6.24 生成 RAR4/RAR5 样本；RAR 7 已不再支持创建 RAR4。
rar a -ma5 -m0 comic_rar5.rar page1.jpg page2.jpg page10.jpg
rar a -ma4 -m0 comic_rar4.rar page1.jpg page2.jpg page10.jpg
rar a -ma5 -m3 -s comic_solid_rar5.rar page1.jpg page2.jpg page10.jpg
rar a -ma4 -m3 -s comic_solid_rar4.rar page1.jpg page2.jpg page10.jpg
rar a -ma5 -m3 -psecret comic_encrypted_rar5.rar page1.jpg page2.jpg
rar a -ma5 -m0 -v60k comic_multi.rar page10.jpg
rar a -ma5 -ol comic_symlink_rar5.rar link.jpg
rar a -ma5 -ap../ comic_traversal.rar page1.jpg
```
