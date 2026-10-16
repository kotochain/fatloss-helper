# 怎么参与修改

这个项目的开发流程很轻，但有几条硬规矩 —— 它们都是踩过坑之后加的。

## 提问题 / 提想法

直接在 Issues 里提，用现成的模板。**报 bug 时最有用的三样东西**：
1. 你在哪一页、做了什么；
2. 实际结果 vs 你期望的结果；
3. 截图或具体数字（例如「一碗面解析成 1200 克」）。

## 改代码的流程

```
1. 开一个分支：git checkout -b fix/牛肉面份量
2. 改代码 + 补测试（改行为就必须补测试）
3. 本地跑：
     npm test
     node tools/mutate-check.mjs      # 确认测试真的能抓到错误
     node tools/check-secrets.mjs     # 确认没有密钥被提交
4. 提 PR，说明：改了什么、为什么、怎么验证的、有什么没验证
```

## 四条硬规矩

1. **不许把密钥写进版本库。** 测试也不行。
   项目里有 `tools/check-secrets.mjs` 会在提交前扫；测试用的假密钥必须写成
   `'sk-fake-for-test' /* secret-scan:allow 假密钥 */` 这种显式豁免，让审查时看得见。

2. **改了行为就要补测试，并且要做反向验证。**
   `node tools/mutate-check.mjs` 会把代码故意改坏，确认测试真的会失败。
   如果一个测试在新旧代码上都通过，它就是摆设，必须重写。

3. **算热量、食物数据、安全下限这三块改动，必须给出独立核算过程。**
   例：改了某食物的热量，要说明数据来源（成分表 / 包装标签 / USDA）并算一遍
   `蛋白×4 + 脂肪×9 + 碳水×4 ≈ 标称热量`。项目里有自动检查会拦住明显抄错的数据。

4. **不要把「读了代码」说成「验证过」。**
   PR 里要写清：哪些是实测的、哪些是推算的、哪些没验证。没测的就写没测。

## 目录速查

| 想改什么 | 改哪里 |
| --- | --- |
| 热量/营养素算法、安全下限 | `js/calc.js` + `tests/calc.test.mjs` |
| 食物数据（加食物、改热量） | `js/foods.js`（有自检，改错会被测试拦住） |
| 一句话记录（解析规则） | `js/mealparse.js` + `tests/ai.test.mjs` 里的基准用例 |
| AI 调用、提示词 | `js/ai-core.js`（提示词）/ `js/ai.js`（调用与兜底） |
| 服务商预设、模型排序 | `js/providers.js` |
| 有氧动作库、换器械算法 | `js/cardio.js` + `tests/cardio.test.mjs` |
| 餐单生成 | `js/recommend.js` |
| 界面 | `js/app.js` + `css/style.css` |

## 自检脚本一览

```bash
npm test                        # 单元测试
node tools/mutate-check.mjs     # 反向验证（在临时副本里做，不动真文件）
node tools/check-secrets.mjs    # 密钥自查（--self-test 连扫描器本身一起验）
node tools/serve.mjs            # 本地起服务，手机同 Wi-Fi 可以打开
node tools/browser-check.mjs    # 无头浏览器自检界面（需先起服务）
node tools/quicklog-check.mjs   # 自检「说一句记录」与「按器械换动作」
node tools/direct-check.mjs     # 自检浏览器直连 AI（用本地假服务商，不花钱）
node tools/ai-e2e-check.mjs     # 自检「电脑中转」路径
node tools/offline-check.mjs    # 断网自检
```
