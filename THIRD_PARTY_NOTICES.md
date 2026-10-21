# 第三方素材说明

这份文件记录仓库里用到的外部素材和它们的许可。**运行时不加载任何外部资源** ——
素材都以内联 SVG 路径的形式写进了 `js/icons.js`，断网也照常显示。

## Phosphor Icons（徽章字形）

- 用途：`js/icons.js` 里 `BADGE_GLYPH` 的 22 个徽章字形（`plant` / `leaf` / `potted-plant` /
  `sun` / `flame` / `sparkle` / `mountains` / `barbell` / `egg` / `fish` / `person-simple-run` /
  `t-shirt` / `scales` / `trend-up` / `receipt` / `flower` / `flower-lotus` / `heart` / `trophy` /
  `medal` / `flower-tulip` / `crown`），取自 **fill** 字重。
- 来源：https://github.com/phosphor-icons/phosphor-core ｜ npm 包 `@phosphor-icons/core@2.1.1`
- 许可：MIT

```
MIT License

Copyright (c) 2023 Phosphor Icons

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 其余图标

界面的线性图标（`js/icons.js` 的 `LINE`）和植物插画（`PLANT`）是本项目自己画的，
跟项目本体一样按仓库根的 `LICENSE` 发布。
