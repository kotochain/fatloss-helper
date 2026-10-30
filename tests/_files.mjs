/**
 * 扫目录时的公共工具：忽略系统元数据文件。
 *
 * 为什么需要这件事（真踩过）：项目放在移动硬盘（exFAT/FAT）上时，macOS 会给**每个**文件
 * 写一份 `._文件名` 的 AppleDouble 影子文件（二进制，内容和真文件无关）。
 * 它和真文件同名同后缀，于是：
 *   - 「离线缓存清单必须覆盖所有 js」把 `js/._app.js` 当成没进清单的 js；
 *   - 「每个 js 模块都能被 Node 加载」去 import 这个二进制，报 Invalid or unexpected token；
 *   - 「文案不许出现第三人称」把二进制当文本读，扫出乱码。
 * 结果是**本机红、CI 绿**——最容易被误判成「代码坏了」的那种假红，白花时间查。
 *
 * 所以：凡是扫目录的测试都走这里，把系统垃圾挡在外面。
 * 同时它也只认「真文件」，目录（万一有同名目录）不算。
 */

import fs from 'node:fs';
import path from 'node:path';

/** 是不是 macOS/Windows 的系统垃圾文件，而不是项目文件 */
export function isSystemJunk(name) {
  return name.startsWith('._') || name === '.DS_Store' || name === 'Thumbs.db';
}

/** 目录里的真文件名（已剔除系统垃圾） */
export function listNames(dir) {
  if (!fs.existsSync(dir)) return []; // 反向验证的沙箱可能只拷了一部分目录
  return fs.readdirSync(dir).filter((f) => !isSystemJunk(f));
}

/** 目录里符合扩展名的真文件绝对路径 */
export function listFiles(dir, re) {
  return listNames(dir)
    .filter((f) => (re ? re.test(f) : true))
    .map((f) => path.join(dir, f));
}

/** 只看文件名、不要路径（离线缓存清单那种要拼 `js/xxx` 的场景） */
export function listAppFiles(dir, ext) {
  return listNames(dir).filter((f) => (ext ? f.endsWith(ext) : true));
}
